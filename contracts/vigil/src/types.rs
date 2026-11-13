use near_sdk::{near, AccountId, NearToken};

/// Milliseconds since the Unix epoch.
pub type TimestampMs = u64;

/// One ten-thousandth. Heir shares are expressed in basis points so that an
/// estate can be split without floating point anywhere in the contract.
pub type BasisPoints = u16;

pub const TOTAL_BASIS_POINTS: u32 = 10_000;

/// Where the vigil stands. The ordering matters: an estate only ever moves
/// forward through this list, except that `Triggered` can return to `Watching`
/// if the owner proves they are alive before settlement completes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[near(serializers = [json, borsh])]
pub enum EstateStatus {
    /// The agent is alive and the owner is checking in on schedule.
    Watching,
    /// The owner has missed check-ins past the grace period. The settlement
    /// plan is committed and signatures may be requested.
    Triggered,
    /// Every chain slot in the plan has a signature. The agent's work is done.
    Settled,
    /// The agent ran out of money before the owner ever went silent. Nothing
    /// is distributed; the estate is untouched and still entirely the owner's.
    Lapsed,
    /// The owner wound the vigil down deliberately.
    Revoked,
}

/// Why the watchman stopped. Kept separate from `EstateStatus` because the
/// cause of death is the single most important thing to show an heir.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[near(serializers = [json, borsh])]
pub enum AgentState {
    /// Funded and keeping watch.
    Alive,
    /// Died having settled the estate. This is the agent fulfilling its purpose.
    Fulfilled,
    /// Died because it could no longer pay for its own existence.
    Starved,
    /// Stood down because the owner revoked the vigil.
    StoodDown,
}

impl AgentState {
    pub fn is_alive(&self) -> bool {
        matches!(self, AgentState::Alive)
    }
}

/// A chain the estate holds value on, and the derivation path that produces
/// the controlling address for it.
///
/// The address is *derived*, never stored as a key. Nobody — not the owner,
/// not the agent, not this contract — ever holds the private key. It only
/// exists as a threshold share across the MPC network.
#[derive(Clone, Debug, PartialEq, Eq)]
#[near(serializers = [json, borsh])]
pub enum Chain {
    /// An EVM chain, identified by its EIP-155 chain id.
    Evm { chain_id: u64 },
}

#[derive(Clone, Debug)]
#[near(serializers = [json, borsh])]
pub struct ChainSlot {
    pub chain: Chain,
    /// The chain-signatures derivation path, e.g. `ethereum-1`. Combined with
    /// this contract's account id it deterministically yields the address.
    pub derivation_path: String,
    /// The derived address, supplied at creation and shown to the owner so
    /// they can fund it. The contract treats this as a label: authority comes
    /// from the derivation path, not from this string.
    pub address: String,
}

/// Someone who inherits. An heir may be named on NEAR, on an EVM chain, or
/// both — the same person usually is.
#[derive(Clone, Debug)]
#[near(serializers = [json, borsh])]
pub struct Heir {
    pub label: String,
    pub near_account: Option<AccountId>,
    /// Lowercase `0x`-prefixed 20-byte address.
    pub evm_address: Option<String>,
    pub basis_points: BasisPoints,
}

/// The agent's own balance sheet. This is the half of the design that makes
/// liveness economic rather than merely chronological: the watchman has
/// running costs, so somebody must keep paying for the watch to continue.
#[derive(Clone, Debug)]
#[near(serializers = [json, borsh])]
pub struct Agent {
    pub state: AgentState,
    /// Unspent treasury, in yoctoNEAR.
    pub balance: NearToken,
    /// What one day of existence costs this agent.
    pub rent_per_day: NearToken,
    /// Last time rent was charged.
    pub last_tick_ms: TimestampMs,
    /// Lifetime totals, kept for the public ledger.
    pub total_rent_paid: NearToken,
    pub total_yield_claimed: NearToken,
    pub total_donated: NearToken,
    pub days_survived: u64,
    pub died_at_ms: Option<TimestampMs>,
}

impl Agent {
    pub fn new(endowment: NearToken, rent_per_day: NearToken, now_ms: TimestampMs) -> Self {
        Self {
            state: AgentState::Alive,
            balance: endowment,
            rent_per_day,
            last_tick_ms: now_ms,
            total_rent_paid: NearToken::from_yoctonear(0),
            total_yield_claimed: NearToken::from_yoctonear(0),
            total_donated: NearToken::from_yoctonear(0),
            days_survived: 0,
            died_at_ms: None,
        }
    }

    /// Rent owed for the time elapsed since the last tick, prorated to the
    /// millisecond. Saturating: an agent can owe more than it holds, which is
    /// exactly the condition that kills it.
    pub fn rent_owed(&self, now_ms: TimestampMs) -> NearToken {
        let elapsed = now_ms.saturating_sub(self.last_tick_ms) as u128;
        if elapsed == 0 {
            return NearToken::from_yoctonear(0);
        }
        const MS_PER_DAY: u128 = 86_400_000;
        NearToken::from_yoctonear(
            self.rent_per_day
                .as_yoctonear()
                .saturating_mul(elapsed)
                / MS_PER_DAY,
        )
    }

    /// How long the agent can keep watch on its current balance, in ms.
    pub fn runway_ms(&self, now_ms: TimestampMs) -> u64 {
        let rent_per_day = self.rent_per_day.as_yoctonear();
        if rent_per_day == 0 {
            return u64::MAX;
        }
        let remaining = self
            .balance
            .as_yoctonear()
            .saturating_sub(self.rent_owed(now_ms).as_yoctonear());
        const MS_PER_DAY: u128 = 86_400_000;
        u64::try_from(remaining.saturating_mul(MS_PER_DAY) / rent_per_day).unwrap_or(u64::MAX)
    }
}
