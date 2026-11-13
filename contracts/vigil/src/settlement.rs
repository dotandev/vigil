//! The settlement plan.
//!
//! Committed the moment silence is declared, and immutable afterwards. The
//! agent's remaining freedom is deliberately narrow: it may choose *when* to
//! settle, what nonce and gas price to use, and how much of the chain balance
//! it has found. It may not choose **who gets paid** or **in what proportion**,
//! because both are fixed here from the heir list the owner set.
//!
//! The residual risk this leaves is an agent that under-reports a balance and
//! strands funds. That is a liveness failure, not theft — the stranded funds
//! stay at an address only the MPC network can sign for, and a replacement
//! agent can settle them later. Theft would require redirecting a leg, which
//! `Vigil::sign_settlement_leg` rejects by re-encoding the transaction.

use near_sdk::json_types::U128;
use near_sdk::near;

use crate::types::{BasisPoints, TimestampMs, TOTAL_BASIS_POINTS};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[near(serializers = [json, borsh])]
pub enum LegStatus {
    AwaitingSignature,
    Signed,
    Broadcast,
}

/// One payment to one heir on one chain.
#[derive(Clone, Debug)]
#[near(serializers = [json, borsh])]
pub struct SettlementLeg {
    pub heir_label: String,
    pub slot_index: u32,
    /// Fixed at commit time from the heir list. `sign_settlement_leg` will not
    /// sign a transaction whose recipient differs from this.
    pub to: String,
    /// Fixed at commit time as `total * basis_points / 10_000`.
    pub value: U128,
    pub basis_points: BasisPoints,
    pub status: LegStatus,
    /// `r || s || v`, hex, once the MPC network has responded.
    pub signature: Option<String>,
    /// The complete signed EIP-1559 transaction, `0x02 || rlp(...)`, encoded
    /// by the contract from the very fields it checked. Anyone can broadcast
    /// it; nobody can change it.
    pub signed_tx: Option<String>,
    pub tx_hash: Option<String>,
}

#[derive(Clone, Debug)]
#[near(serializers = [json, borsh])]
pub struct SettlementPlan {
    pub committed_at_ms: TimestampMs,
    /// What the agent reported the estate held on this chain when silence was
    /// declared. Recorded so an heir can check it against a block explorer.
    pub total_reported: U128,
    pub legs: Vec<SettlementLeg>,
}

impl SettlementPlan {
    /// Split `total` across heirs by basis points. Integer division only; the
    /// remainder from rounding goes to the first heir rather than being
    /// silently burned, so the legs always sum to exactly `total`.
    pub fn commit(
        now_ms: TimestampMs,
        total: u128,
        slot_index: u32,
        heirs: &[(String, String, BasisPoints)],
    ) -> Self {
        let mut legs: Vec<SettlementLeg> = heirs
            .iter()
            .map(|(label, to, bps)| SettlementLeg {
                heir_label: label.clone(),
                slot_index,
                to: to.clone(),
                value: U128(total * (*bps as u128) / TOTAL_BASIS_POINTS as u128),
                basis_points: *bps,
                status: LegStatus::AwaitingSignature,
                signature: None,
                signed_tx: None,
                tx_hash: None,
            })
            .collect();

        let assigned: u128 = legs.iter().map(|l| l.value.0).sum();
        if let Some(first) = legs.first_mut() {
            first.value = U128(first.value.0 + (total - assigned));
        }

        Self { committed_at_ms: now_ms, total_reported: U128(total), legs }
    }

    pub fn is_complete(&self) -> bool {
        !self.legs.is_empty()
            && self
                .legs
                .iter()
                .all(|l| matches!(l.status, LegStatus::Signed | LegStatus::Broadcast))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn heirs() -> Vec<(String, String, BasisPoints)> {
        vec![
            ("Amina".into(), "0x1111111111111111111111111111111111111111".into(), 5_000),
            ("Tunde".into(), "0x2222222222222222222222222222222222222222".into(), 3_000),
            ("Zainab".into(), "0x3333333333333333333333333333333333333333".into(), 2_000),
        ]
    }

    #[test]
    fn legs_sum_to_the_exact_total() {
        // A total that does not divide cleanly by any of the shares.
        let total = 1_000_000_000_000_000_007u128;
        let plan = SettlementPlan::commit(0, total, 0, &heirs());
        let summed: u128 = plan.legs.iter().map(|l| l.value.0).sum();
        assert_eq!(summed, total, "rounding dust must not vanish");
    }

    #[test]
    fn shares_follow_basis_points() {
        let plan = SettlementPlan::commit(0, 10_000, 0, &heirs());
        assert_eq!(plan.legs[1].value.0, 3_000);
        assert_eq!(plan.legs[2].value.0, 2_000);
    }

    #[test]
    fn a_plan_with_no_legs_is_never_complete() {
        let plan = SettlementPlan { committed_at_ms: 0, total_reported: U128(0), legs: vec![] };
        assert!(!plan.is_complete());
    }
}
