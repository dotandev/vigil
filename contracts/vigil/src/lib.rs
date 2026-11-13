//! # Vigil
//!
//! A watchman that is paid by what it guards, and dies when you do.
//!
//! An owner opens a vigil and endows an agent. The agent's only job is to
//! watch for the owner's check-ins, and existing costs it money every day. If
//! the owner goes silent past the grace period, the agent commits an immutable
//! settlement plan and asks the MPC network to sign transfers to the heirs on
//! every chain the estate touches. Then it reclaims its own storage and stops.
//!
//! Two deaths are possible and the difference between them is the point:
//!
//! * **Fulfilled** — the owner went silent, the estate was settled, the agent's
//!   last act was its purpose.
//! * **Starved** — the agent ran out of money first. Nothing is distributed.
//!   The estate is untouched and still entirely the owner's, and the lapse is
//!   public, so heirs learn that the watch has stopped instead of discovering
//!   years later that it silently had.
//!
//! No private key for the estate's foreign-chain addresses exists anywhere.
//! They are derived from this contract's account id plus a derivation path,
//! and can only be signed for by a threshold of the MPC network, at this
//! contract's request, under the rules below.

use near_sdk::json_types::U128;
use near_sdk::store::IterableMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

mod events;
#[cfg(test)]
mod tests;
mod evm;
mod mpc;
mod settlement;
mod types;

pub use evm::Eip1559Fields;
pub use settlement::{LegStatus, SettlementLeg, SettlementPlan};
pub use types::*;

use events::VigilEvent;

/// A vigil whose rent is zero is not a vigil, it is a cron job. The floor
/// keeps the economic claim honest.
pub const ABSOLUTE_MIN_RENT_PER_DAY: NearToken = NearToken::from_millinear(1);

const HARVEST_CALLBACK_GAS: Gas = Gas::from_tgas(20);
const HARVEST_GAS: Gas = Gas::from_tgas(40);

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Estates,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Estate {
    pub owner: AccountId,
    pub heirs: Vec<Heir>,
    pub slots: Vec<ChainSlot>,
    pub check_in_interval_ms: u64,
    pub grace_period_ms: u64,
    pub last_check_in_ms: TimestampMs,
    pub status: EstateStatus,
    pub agent: Agent,
    /// One plan per chain slot, committed together when silence is declared.
    pub plans: Vec<SettlementPlan>,
    /// Ceiling on the gas price the agent may sign for, so a hostile agent
    /// cannot burn the estate as transaction fees.
    pub max_fee_per_gas_cap: U128,
    /// Where the agent earns its keep, if anywhere.
    pub yield_source: Option<AccountId>,
}

impl Estate {
    pub fn silent_since_ms(&self) -> TimestampMs {
        self.last_check_in_ms
            .saturating_add(self.check_in_interval_ms)
            .saturating_add(self.grace_period_ms)
    }

    pub fn is_silent_at(&self, now_ms: TimestampMs) -> bool {
        now_ms >= self.silent_since_ms()
    }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vigil {
    /// `v1.signer-prod.testnet` on testnet, `v1.signer` on mainnet.
    pub mpc_signer: AccountId,
    pub min_rent_per_day: NearToken,
    pub estates: IterableMap<AccountId, Estate>,
}

#[near]
impl Vigil {
    #[init]
    pub fn new(mpc_signer: AccountId, min_rent_per_day: Option<NearToken>) -> Self {
        let min_rent_per_day = min_rent_per_day.unwrap_or(ABSOLUTE_MIN_RENT_PER_DAY);
        require!(
            min_rent_per_day >= ABSOLUTE_MIN_RENT_PER_DAY,
            "minimum rent is below the floor"
        );
        Self {
            mpc_signer,
            min_rent_per_day,
            estates: IterableMap::new(StorageKey::Estates),
        }
    }

    // ---------------------------------------------------------------- opening

    /// Open a vigil. The attached deposit endows the agent; that endowment is
    /// what the agent spends to stay alive, and when it is gone the agent dies.
    #[payable]
    pub fn open_vigil(
        &mut self,
        heirs: Vec<Heir>,
        slots: Vec<ChainSlot>,
        check_in_interval_ms: u64,
        grace_period_ms: u64,
        rent_per_day: NearToken,
        max_fee_per_gas_cap: U128,
        yield_source: Option<AccountId>,
    ) -> VigilStatusView {
        let owner = env::predecessor_account_id();
        require!(
            !self.estates.contains_key(&owner),
            "this account already has a vigil; revoke it first"
        );
        Self::validate_heirs(&heirs);
        require!(!slots.is_empty(), "a vigil needs at least one chain slot");
        Self::validate_slots(&owner, &slots);
        require!(check_in_interval_ms > 0, "check-in interval must be positive");
        require!(
            rent_per_day >= self.min_rent_per_day,
            "rent per day is below the contract minimum"
        );

        let endowment = env::attached_deposit();
        Self::require_survives_first_window(
            endowment,
            rent_per_day,
            check_in_interval_ms,
            grace_period_ms,
        );

        let now = env::block_timestamp_ms();
        let agent = Agent::new(endowment, rent_per_day, now);
        let runway_days = agent.runway_ms(now) / 86_400_000;

        let estate = Estate {
            owner: owner.clone(),
            heirs,
            slots,
            check_in_interval_ms,
            grace_period_ms,
            last_check_in_ms: now,
            status: EstateStatus::Watching,
            agent,
            plans: Vec::new(),
            max_fee_per_gas_cap,
            yield_source,
        };

        VigilEvent::VigilOpened {
            owner: &owner,
            rent_per_day: rent_per_day.as_yoctonear().to_string(),
            runway_days,
        }
        .emit();

        self.estates.insert(owner.clone(), estate);
        self.status_of(owner)
    }

    /// Restart a vigil whose agent starved. Only the owner may do this, which
    /// is the property that makes starvation safe: a lapsed vigil can never
    /// distribute anything, it can only be revived by the person it protects.
    #[payable]
    pub fn reopen_vigil(&mut self, rent_per_day: Option<NearToken>) -> VigilStatusView {
        let owner = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        let min_rent = self.min_rent_per_day;
        let estate = self.estate_mut(&owner);
        require!(
            estate.status == EstateStatus::Lapsed,
            "only a lapsed vigil can be reopened"
        );

        let rent_per_day = rent_per_day.unwrap_or(estate.agent.rent_per_day);
        require!(rent_per_day >= min_rent, "rent per day is below the contract minimum");

        let endowment = env::attached_deposit();
        let (interval, grace) = (estate.check_in_interval_ms, estate.grace_period_ms);
        Self::require_survives_first_window(endowment, rent_per_day, interval, grace);

        let estate = self.estate_mut(&owner);
        estate.agent = Agent::new(endowment, rent_per_day, now);
        estate.last_check_in_ms = now;
        estate.status = EstateStatus::Watching;
        self.status_of(owner)
    }

    // --------------------------------------------------------------- liveness

    /// "I am alive." The only method the owner needs to remember.
    pub fn check_in(&mut self) -> VigilStatusView {
        let owner = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        Self::settle_rent(self.estate_mut(&owner), now);

        let estate = self.estate_mut(&owner);
        require!(
            matches!(estate.status, EstateStatus::Watching | EstateStatus::Triggered),
            "this vigil is no longer watching"
        );
        require!(estate.agent.state.is_alive(), "the agent is dead");

        // Checking in during the window between a trigger and the last
        // signature pulls the estate back. This is the "alive but offline"
        // case, and it has to work right up to the final moment.
        if estate.status == EstateStatus::Triggered {
            estate.plans.clear();
            estate.status = EstateStatus::Watching;
        }
        estate.last_check_in_ms = now;
        let next_due_ms = now + estate.check_in_interval_ms;

        VigilEvent::CheckedIn { owner: &owner, next_due_ms }.emit();
        self.status_of(owner)
    }

    /// Pay for somebody's watchman. Permissionless on purpose: an heir has
    /// every reason to keep alive the agent that will one day pay them, which
    /// turns the running cost into something the beneficiaries will carry.
    #[payable]
    pub fn feed(&mut self, owner: AccountId) -> VigilStatusView {
        let amount = env::attached_deposit();
        require!(amount.as_yoctonear() > 0, "nothing attached");
        let by = env::predecessor_account_id();
        let now = env::block_timestamp_ms();

        Self::settle_rent(self.estate_mut(&owner), now);
        let estate = self.estate_mut(&owner);
        require!(
            estate.agent.state.is_alive(),
            "the agent is dead; the owner must reopen the vigil"
        );
        estate.agent.balance = estate.agent.balance.saturating_add(amount);
        estate.agent.total_donated = estate.agent.total_donated.saturating_add(amount);
        let runway_days = estate.agent.runway_ms(now) / 86_400_000;

        VigilEvent::AgentFed {
            owner: &owner,
            by: &by,
            amount: amount.as_yoctonear().to_string(),
            runway_days,
        }
        .emit();
        self.status_of(owner)
    }

    /// Charge the rent the agent owes. Permissionless, and anyone may call it:
    /// the agent's mortality must not depend on the agent's own cooperation.
    pub fn tick(&mut self, owner: AccountId) -> VigilStatusView {
        let now = env::block_timestamp_ms();
        Self::settle_rent(self.estate_mut(&owner), now);
        self.status_of(owner)
    }

    // ------------------------------------------------------------ settlement

    /// Declare that the owner has gone silent and commit the settlement plan.
    ///
    /// Permissionless, because a watchman nobody can poke is a watchman that
    /// fails quietly. The contract itself checks the clock, so calling this
    /// early simply panics.
    ///
    /// `reported_balances` is one amount per chain slot, in that chain's base
    /// unit, as observed by the caller. It decides *how much* is distributed;
    /// it cannot affect *to whom*, which comes from the owner's heir list.
    pub fn declare_silence(
        &mut self,
        owner: AccountId,
        reported_balances: Vec<U128>,
    ) -> VigilStatusView {
        let now = env::block_timestamp_ms();
        Self::settle_rent(self.estate_mut(&owner), now);

        let estate = self.estate_mut(&owner);
        require!(
            estate.agent.state.is_alive(),
            "a dead agent cannot settle an estate"
        );
        require!(
            estate.status == EstateStatus::Watching,
            "this vigil is not watching"
        );
        require!(
            estate.is_silent_at(now),
            "the owner is not yet silent; check-in window has not elapsed"
        );
        require!(
            reported_balances.len() == estate.slots.len(),
            "one reported balance is required per chain slot"
        );

        let heirs: Vec<(String, String, BasisPoints)> = estate
            .heirs
            .iter()
            .filter_map(|h| {
                h.evm_address
                    .as_ref()
                    .map(|a| (h.label.clone(), a.clone(), h.basis_points))
            })
            .collect();
        require!(!heirs.is_empty(), "no heir has an address on a supported chain");

        let mut legs = 0u32;
        estate.plans = reported_balances
            .iter()
            .enumerate()
            .map(|(slot_index, total)| {
                let plan =
                    SettlementPlan::commit(now, total.0, slot_index as u32, &heirs);
                legs += plan.legs.len() as u32;
                plan
            })
            .collect();
        estate.status = EstateStatus::Triggered;
        let last_check_in_ms = estate.last_check_in_ms;

        VigilEvent::SilenceDeclared { owner: &owner, last_check_in_ms, legs }.emit();
        self.status_of(owner)
    }

    /// Ask the MPC network to sign one leg of the committed plan.
    ///
    /// The agent supplies the transaction *fields*. The contract re-encodes
    /// them and signs the digest it computed itself, after checking the
    /// recipient and amount against the plan. There is no code path that signs
    /// a caller-supplied hash.
    #[payable]
    pub fn sign_settlement_leg(
        &mut self,
        owner: AccountId,
        plan_index: u32,
        leg_index: u32,
        fields: Eip1559Fields,
    ) -> Promise {
        require!(
            env::attached_deposit() >= mpc::SIGN_DEPOSIT,
            "attach 1 yoctoNEAR for the signer"
        );
        let estate = self
            .estates
            .get(&owner)
            .unwrap_or_else(|| env::panic_str("no vigil for that account"));

        require!(
            estate.agent.state.is_alive(),
            "a dead agent cannot settle an estate"
        );
        require!(estate.status == EstateStatus::Triggered, "no silence declared");

        let plan = estate
            .plans
            .get(plan_index as usize)
            .unwrap_or_else(|| env::panic_str("no such plan"));
        let leg = plan
            .legs
            .get(leg_index as usize)
            .unwrap_or_else(|| env::panic_str("no such leg"));
        require!(
            leg.status == LegStatus::AwaitingSignature,
            "this leg is already signed"
        );

        let slot = estate
            .slots
            .get(plan.legs[leg_index as usize].slot_index as usize)
            .unwrap_or_else(|| env::panic_str("no such chain slot"));
        let Chain::Evm { chain_id } = slot.chain;

        // The three checks that make this safe.
        require!(
            fields.chain_id == chain_id,
            "transaction is for a different chain than the slot"
        );
        require!(
            evm::addresses_match(&fields.to, &leg.to),
            "recipient does not match the committed settlement plan"
        );
        require!(
            fields.value.0 == leg.value.0,
            "amount does not match the committed settlement plan"
        );
        require!(
            fields.max_fee_per_gas.0 <= estate.max_fee_per_gas_cap.0,
            "gas price exceeds the cap the owner set"
        );

        let digest = fields
            .signing_hash()
            .unwrap_or_else(|e| env::panic_str(e));
        let path = slot.derivation_path.clone();

        mpc::ext_mpc::ext(self.mpc_signer.clone())
            .with_attached_deposit(mpc::SIGN_DEPOSIT)
            .with_static_gas(mpc::SIGN_GAS)
            .sign(mpc::SignRequestArgs::ecdsa(path, &digest))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(mpc::SIGN_CALLBACK_GAS)
                    .on_settlement_signed(owner, plan_index, leg_index, fields),
            )
    }

    #[private]
    pub fn on_settlement_signed(
        &mut self,
        owner: AccountId,
        plan_index: u32,
        leg_index: u32,
        fields: Eip1559Fields,
        #[callback_result] result: Result<mpc::SignatureResponse, PromiseError>,
    ) -> bool {
        let Ok(signature) = result else {
            // The MPC network declined or timed out. The leg stays unsigned
            // and can simply be retried; nothing about the plan changes.
            env::log_str("vigil: signature request failed, leg left unsigned");
            return false;
        };

        let mpc::SignatureResponse::Secp256k1 { big_r, s, recovery_id } = signature;
        // `big_r` is a compressed point; its x-coordinate is r.
        let r = big_r.affine_point.get(2..).unwrap_or_default().to_string();
        let encoded = format!("0x{}{}{:02x}", r, s.scalar, recovery_id);

        // Assemble the broadcastable transaction from the fields that were
        // checked against the plan. If the response is somehow malformed the
        // signature is still recorded and the transaction can be built off-chain.
        let signed_tx = match (hex::decode(&r), hex::decode(&s.scalar)) {
            (Ok(r), Ok(s)) => fields
                .signed_raw(recovery_id, &r, &s)
                .ok()
                .map(|raw| format!("0x{}", hex::encode(raw))),
            _ => None,
        };

        let estate = self.estate_mut(&owner);
        let (to, value) = {
            let leg = &mut estate.plans[plan_index as usize].legs[leg_index as usize];
            leg.signature = Some(encoded);
            leg.signed_tx = signed_tx;
            leg.status = LegStatus::Signed;
            (leg.to.clone(), leg.value.0.to_string())
        };

        VigilEvent::SettlementSigned { owner: &owner, leg: leg_index, to: &to, value }.emit();
        self.finalize_if_complete(&owner);
        true
    }

    /// Record the hash of a broadcast settlement transaction so an heir can
    /// follow it on a block explorer.
    pub fn record_broadcast(
        &mut self,
        owner: AccountId,
        plan_index: u32,
        leg_index: u32,
        tx_hash: String,
    ) {
        let estate = self.estate_mut(&owner);
        let leg = &mut estate.plans[plan_index as usize].legs[leg_index as usize];
        require!(leg.status != LegStatus::AwaitingSignature, "leg is not signed yet");
        leg.tx_hash = Some(tx_hash.clone());
        leg.status = LegStatus::Broadcast;
        VigilEvent::SettlementBroadcast { owner: &owner, leg: leg_index, tx_hash: &tx_hash }
            .emit();
    }

    // ------------------------------------------------------------------ yield

    /// Draw the agent's wages from whatever the estate earns. This is what
    /// lets a vigil outlive the attention of the person who opened it.
    pub fn harvest(&mut self, owner: AccountId) -> Promise {
        let estate = self
            .estates
            .get(&owner)
            .unwrap_or_else(|| env::panic_str("no vigil for that account"));
        let source = estate
            .yield_source
            .clone()
            .unwrap_or_else(|| env::panic_str("this vigil has no yield source"));

        ext_yield_source::ext(source)
            .with_static_gas(HARVEST_GAS)
            .harvest_yield(env::current_account_id())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(HARVEST_CALLBACK_GAS)
                    .on_harvested(owner),
            )
    }

    #[private]
    pub fn on_harvested(
        &mut self,
        owner: AccountId,
        #[callback_result] result: Result<U128, PromiseError>,
    ) -> U128 {
        let Ok(amount) = result else {
            env::log_str("vigil: harvest failed");
            return U128(0);
        };
        let now = env::block_timestamp_ms();
        Self::settle_rent(self.estate_mut(&owner), now);

        let estate = self.estate_mut(&owner);
        let earned = NearToken::from_yoctonear(amount.0);
        estate.agent.balance = estate.agent.balance.saturating_add(earned);
        estate.agent.total_yield_claimed =
            estate.agent.total_yield_claimed.saturating_add(earned);

        VigilEvent::YieldHarvested { owner: &owner, amount: amount.0.to_string() }.emit();
        amount
    }

    // ---------------------------------------------------------------- winding

    /// Stand the watchman down and take back what is left of its endowment.
    pub fn revoke(&mut self) -> Promise {
        let owner = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        Self::settle_rent(self.estate_mut(&owner), now);

        let estate = self.estate_mut(&owner);
        require!(
            estate.status != EstateStatus::Settled,
            "this estate has already been settled"
        );
        let refund = estate.agent.balance;
        estate.agent.balance = NearToken::from_yoctonear(0);
        estate.agent.state = AgentState::StoodDown;
        estate.agent.died_at_ms = Some(now);
        estate.status = EstateStatus::Revoked;

        VigilEvent::VigilRevoked { owner: &owner, refunded: refund.as_yoctonear().to_string() }
            .emit();
        self.estates.remove(&owner);
        Promise::new(owner).transfer(refund)
    }

    // ------------------------------------------------------------------ views

    pub fn get_estate(&self, owner: AccountId) -> Option<Estate> {
        self.estates.get(&owner).cloned()
    }

    pub fn get_status(&self, owner: AccountId) -> VigilStatusView {
        self.status_of(owner)
    }

    pub fn list_owners(&self) -> Vec<AccountId> {
        self.estates.keys().cloned().collect()
    }

    pub fn get_mpc_signer(&self) -> AccountId {
        self.mpc_signer.clone()
    }

    /// What the agent would owe right now. Lets a watcher decide whether a
    /// `tick` is worth the gas.
    pub fn pending_rent(&self, owner: AccountId) -> U128 {
        match self.estates.get(&owner) {
            Some(e) => U128(e.agent.rent_owed(env::block_timestamp_ms()).as_yoctonear()),
            None => U128(0),
        }
    }

    // --------------------------------------------------------------- internal

    fn estate_mut(&mut self, owner: &AccountId) -> &mut Estate {
        self.estates
            .get_mut(owner)
            .unwrap_or_else(|| env::panic_str("no vigil for that account"))
    }

    /// An agent must be able to live at least until the first deadline it is
    /// supposed to be watching for. Anything less is a vigil that was already
    /// over when it was opened, which is worse than no vigil at all: it looks
    /// like protection and is not.
    ///
    /// Note this is deliberately *not* "a day of rent". Tying the floor to a
    /// wall-clock day would forbid short-horizon vigils, which are exactly
    /// what testing and demonstrating this thing requires.
    fn require_survives_first_window(
        endowment: NearToken,
        rent_per_day: NearToken,
        check_in_interval_ms: u64,
        grace_period_ms: u64,
    ) {
        let first_window = check_in_interval_ms.saturating_add(grace_period_ms);
        let rent = rent_per_day.as_yoctonear();
        if rent == 0 {
            return;
        }
        let runway_ms = endowment
            .as_yoctonear()
            .saturating_mul(86_400_000)
            / rent;
        require!(
            runway_ms >= first_window as u128,
            "endowment must outlast the first check-in window"
        );
    }

    /// The estate's address is derived from (this contract, derivation path)
    /// alone, so the path is the only thing separating one owner's estate from
    /// another's. Without this check anyone could open a vigil over somebody
    /// else's path, name themselves as heir, go silent, and have the MPC
    /// network sign away an estate that was never theirs. Namespacing every
    /// path under the owner's account id makes collisions impossible: account
    /// ids cannot contain '/', so no other owner can produce the same prefix.
    fn validate_slots(owner: &AccountId, slots: &[ChainSlot]) {
        let prefix = format!("{owner}/");
        for (i, slot) in slots.iter().enumerate() {
            require!(
                slot.derivation_path.len() > prefix.len()
                    && slot.derivation_path.starts_with(&prefix),
                "a derivation path must be the owner's account id, a slash, and a name"
            );
            require!(
                !slots[..i].iter().any(|s| s.derivation_path == slot.derivation_path),
                "each chain slot needs its own derivation path"
            );
        }
    }

    fn validate_heirs(heirs: &[Heir]) {
        require!(!heirs.is_empty(), "a vigil needs at least one heir");
        let total: u32 = heirs.iter().map(|h| h.basis_points as u32).sum();
        require!(
            total == TOTAL_BASIS_POINTS,
            "heir shares must sum to exactly 10000 basis points"
        );
        for heir in heirs {
            require!(heir.basis_points > 0, "an heir cannot be left zero");
            require!(
                heir.near_account.is_some() || heir.evm_address.is_some(),
                "every heir needs at least one address"
            );
            if let Some(address) = &heir.evm_address {
                require!(
                    evm::parse_address(address).is_ok(),
                    "an heir has a malformed EVM address"
                );
            }
        }
    }

    /// Charge rent for elapsed time, and kill the agent if it cannot pay.
    ///
    /// Rent accrues only while the agent is *watching*. Once silence has been
    /// declared the agent is executing the task it was endowed for, and
    /// charging it rent mid-settlement would strand an estate for the sake of
    /// a metaphor.
    fn settle_rent(estate: &mut Estate, now_ms: TimestampMs) {
        if !estate.agent.state.is_alive() || estate.status != EstateStatus::Watching {
            return;
        }
        let owed = estate.agent.rent_owed(now_ms);
        if owed.as_yoctonear() == 0 {
            return;
        }

        if estate.agent.balance >= owed {
            estate.agent.balance = estate.agent.balance.saturating_sub(owed);
            estate.agent.total_rent_paid = estate.agent.total_rent_paid.saturating_add(owed);
            estate.agent.days_survived += (now_ms - estate.agent.last_tick_ms) / 86_400_000;
            estate.agent.last_tick_ms = now_ms;

            let owner = estate.owner.clone();
            let runway_days = estate.agent.runway_ms(now_ms) / 86_400_000;
            VigilEvent::RentCharged {
                owner: &owner,
                amount: owed.as_yoctonear().to_string(),
                balance: estate.agent.balance.as_yoctonear().to_string(),
                runway_days,
            }
            .emit();
        } else {
            estate.agent.balance = NearToken::from_yoctonear(0);
            estate.agent.state = AgentState::Starved;
            estate.agent.died_at_ms = Some(now_ms);
            estate.agent.last_tick_ms = now_ms;
            estate.status = EstateStatus::Lapsed;

            let owner = estate.owner.clone();
            VigilEvent::AgentStarved { owner: &owner, at_ms: now_ms }.emit();
        }
    }

    /// When every leg is signed the agent's work is finished. It marks itself
    /// fulfilled and sends what is left of its endowment on to the heirs — the
    /// watchman's last act is to stop costing the estate money.
    fn finalize_if_complete(&mut self, owner: &AccountId) {
        let estate = self.estate_mut(owner);
        if estate.plans.is_empty() || !estate.plans.iter().all(|p| p.is_complete()) {
            return;
        }
        let now = env::block_timestamp_ms();
        estate.status = EstateStatus::Settled;
        estate.agent.state = AgentState::Fulfilled;
        estate.agent.died_at_ms = Some(now);

        let remainder = estate.agent.balance;
        estate.agent.balance = NearToken::from_yoctonear(0);
        let days_survived = estate.agent.days_survived;

        let near_heirs: Vec<(AccountId, u32)> = estate
            .heirs
            .iter()
            .filter_map(|h| h.near_account.clone().map(|a| (a, h.basis_points as u32)))
            .collect();
        let owner_account = estate.owner.clone();

        VigilEvent::AgentFulfilled { owner, at_ms: now, days_survived }.emit();

        if remainder.as_yoctonear() == 0 {
            return;
        }
        let total_bps: u32 = near_heirs.iter().map(|(_, b)| *b).sum();
        if total_bps == 0 {
            let _ = Promise::new(owner_account).transfer(remainder);
            return;
        }
        for (account, bps) in near_heirs {
            let share = NearToken::from_yoctonear(
                remainder.as_yoctonear() * bps as u128 / total_bps as u128,
            );
            if share.as_yoctonear() > 0 {
                let _ = Promise::new(account).transfer(share);
            }
        }
    }

    fn status_of(&self, owner: AccountId) -> VigilStatusView {
        let now = env::block_timestamp_ms();
        let estate = self
            .estates
            .get(&owner)
            .unwrap_or_else(|| env::panic_str("no vigil for that account"));
        VigilStatusView {
            owner: owner.clone(),
            status: estate.status,
            agent_state: estate.agent.state,
            agent_balance: estate.agent.balance,
            rent_per_day: estate.agent.rent_per_day,
            runway_ms: estate.agent.runway_ms(now),
            last_check_in_ms: estate.last_check_in_ms,
            silent_at_ms: estate.silent_since_ms(),
            is_silent: estate.is_silent_at(now),
            days_survived: estate.agent.days_survived,
            total_rent_paid: estate.agent.total_rent_paid,
            total_yield_claimed: estate.agent.total_yield_claimed,
            total_donated: estate.agent.total_donated,
            legs_total: estate.plans.iter().map(|p| p.legs.len() as u32).sum(),
            legs_signed: estate
                .plans
                .iter()
                .flat_map(|p| p.legs.iter())
                .filter(|l| l.status != LegStatus::AwaitingSignature)
                .count() as u32,
        }
    }
}

/// Everything a dashboard or an heir needs, in one view call.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct VigilStatusView {
    pub owner: AccountId,
    pub status: EstateStatus,
    pub agent_state: AgentState,
    pub agent_balance: NearToken,
    pub rent_per_day: NearToken,
    pub runway_ms: u64,
    pub last_check_in_ms: TimestampMs,
    pub silent_at_ms: TimestampMs,
    pub is_silent: bool,
    pub days_survived: u64,
    pub total_rent_paid: NearToken,
    pub total_yield_claimed: NearToken,
    pub total_donated: NearToken,
    pub legs_total: u32,
    pub legs_signed: u32,
}

/// Anything that can pay an agent's wages. A mock pool ships with this repo;
/// a real staking-pool adapter implements the same single method.
#[near_sdk::ext_contract(ext_yield_source)]
pub trait YieldSource {
    fn harvest_yield(&mut self, account_id: AccountId) -> U128;
}
