//! NEP-297 events. The vigil's whole value is that an heir can see what
//! happened and when, so every state change says so publicly.

use near_sdk::serde::Serialize;
use near_sdk::{env, serde_json, AccountId};

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde", tag = "event", content = "data")]
#[serde(rename_all = "snake_case")]
pub enum VigilEvent<'a> {
    VigilOpened { owner: &'a AccountId, rent_per_day: String, runway_days: u64 },
    CheckedIn { owner: &'a AccountId, next_due_ms: u64 },
    AgentFed { owner: &'a AccountId, by: &'a AccountId, amount: String, runway_days: u64 },
    YieldHarvested { owner: &'a AccountId, amount: String },
    RentCharged { owner: &'a AccountId, amount: String, balance: String, runway_days: u64 },
    /// The watchman could not pay for itself. Nothing is distributed.
    AgentStarved { owner: &'a AccountId, at_ms: u64 },
    /// The owner went silent past the grace period.
    SilenceDeclared { owner: &'a AccountId, last_check_in_ms: u64, legs: u32 },
    SettlementSigned { owner: &'a AccountId, leg: u32, to: &'a str, value: String },
    SettlementBroadcast { owner: &'a AccountId, leg: u32, tx_hash: &'a str },
    /// The agent finished its work and reclaimed its own storage.
    AgentFulfilled { owner: &'a AccountId, at_ms: u64, days_survived: u64 },
    VigilRevoked { owner: &'a AccountId, refunded: String },
}

impl VigilEvent<'_> {
    pub fn emit(self) {
        let payload = serde_json::json!({
            "standard": "vigil",
            "version": "1.0.0",
            "event": serde_json::to_value(&self).unwrap().get("event").cloned().unwrap(),
            "data": [serde_json::to_value(&self).unwrap().get("data").cloned().unwrap()],
        });
        env::log_str(&format!("EVENT_JSON:{}", payload));
    }
}
