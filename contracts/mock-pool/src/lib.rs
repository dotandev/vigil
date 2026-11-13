//! A stand-in yield source.
//!
//! The real one is a NEAR staking pool. The reason this exists is a timing
//! mismatch, not a capability one: staking rewards land once per epoch
//! (~12 hours) and unstaked NEAR is locked for four epochs (~48 hours), which
//! is longer than the entire hackathon. A demo that waits two days proves
//! nothing to anyone watching.
//!
//! So this contract implements the same one-method `YieldSource` interface the
//! vigil calls, accruing at a configurable rate per *second* instead of per
//! epoch. Swapping in a real pool means writing an adapter with the same
//! method that calls `ping`, `unstake` and `withdraw` and respects the
//! four-epoch delay — see `docs/yield-sources.md`.
//!
//! Nothing here is load-bearing for the security of a vigil: the worst a
//! malicious yield source can do is pay an agent less than it promised, which
//! starves the agent, which is the safe failure.

use near_sdk::json_types::U128;
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise};

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Principals,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Position {
    pub principal: NearToken,
    pub last_harvest_ms: u64,
    pub total_paid: NearToken,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockPool {
    /// Yield paid per second, in basis points of principal. 1 bps/second is
    /// absurd as finance and ideal as a demo.
    pub bps_per_second: u32,
    pub positions: IterableMap<AccountId, Position>,
}

#[near]
impl MockPool {
    #[init]
    pub fn new(bps_per_second: u32) -> Self {
        require!(bps_per_second > 0, "a yield source must yield something");
        Self { bps_per_second, positions: IterableMap::new(StorageKey::Principals) }
    }

    /// Stake on behalf of an account. The vigil contract is the depositor and
    /// also the beneficiary.
    #[payable]
    pub fn deposit(&mut self, account_id: AccountId) -> U128 {
        let amount = env::attached_deposit();
        require!(amount.as_yoctonear() > 0, "nothing attached");
        let now = env::block_timestamp_ms();
        let position = self.positions.entry(account_id).or_insert(Position {
            principal: NearToken::from_yoctonear(0),
            last_harvest_ms: now,
            total_paid: NearToken::from_yoctonear(0),
        });
        position.principal = position.principal.saturating_add(amount);
        U128(position.principal.as_yoctonear())
    }

    /// Pay out everything accrued since the last harvest, to the caller.
    pub fn harvest_yield(&mut self, account_id: AccountId) -> Promise {
        let now = env::block_timestamp_ms();
        let caller = env::predecessor_account_id();
        let bps_per_second = self.bps_per_second;

        let position = self
            .positions
            .get_mut(&account_id)
            .unwrap_or_else(|| env::panic_str("no position for that account"));

        let elapsed_s = (now.saturating_sub(position.last_harvest_ms)) as u128 / 1_000;
        let accrued = position
            .principal
            .as_yoctonear()
            .saturating_mul(bps_per_second as u128)
            .saturating_mul(elapsed_s)
            / 10_000;

        position.last_harvest_ms = now;
        position.total_paid = position
            .total_paid
            .saturating_add(NearToken::from_yoctonear(accrued));

        let payable = accrued.min(
            env::account_balance()
                .as_yoctonear()
                .saturating_sub(NearToken::from_near(1).as_yoctonear()),
        );
        Promise::new(caller).transfer(NearToken::from_yoctonear(payable))
    }

    pub fn get_position(&self, account_id: AccountId) -> Option<Position> {
        self.positions.get(&account_id).cloned()
    }

    pub fn accrued(&self, account_id: AccountId) -> U128 {
        let now = env::block_timestamp_ms();
        match self.positions.get(&account_id) {
            None => U128(0),
            Some(p) => {
                let elapsed_s = (now.saturating_sub(p.last_harvest_ms)) as u128 / 1_000;
                U128(
                    p.principal
                        .as_yoctonear()
                        .saturating_mul(self.bps_per_second as u128)
                        .saturating_mul(elapsed_s)
                        / 10_000,
                )
            }
        }
    }
}
