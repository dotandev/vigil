//! Behavioural tests for the vigil.
//!
//! These exist to pin down the properties that make the design safe rather
//! than merely clever. In rough order of how much damage their absence would
//! do:
//!
//! 1. A dead agent can never move anybody's money.
//! 2. A living agent can only move it to the people the owner named, in the
//!    proportions the owner set.
//! 3. An owner who is alive but was merely offline can always pull back.

use near_sdk::json_types::U128;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken};

use crate::*;

const MS: u64 = 1_000_000; // one millisecond in nanoseconds
const DAY_MS: u64 = 86_400_000;

fn signer() -> AccountId {
    "v1.signer-prod.testnet".parse().unwrap()
}

fn owner() -> AccountId {
    accounts(1)
}

fn stranger() -> AccountId {
    accounts(2)
}

fn ctx(predecessor: AccountId, deposit: NearToken, now_ms: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id(predecessor)
        .attached_deposit(deposit)
        .block_timestamp(now_ms * MS);
    b
}

fn heirs() -> Vec<Heir> {
    vec![
        Heir {
            label: "Amina".into(),
            near_account: Some(accounts(3)),
            evm_address: Some("0x1111111111111111111111111111111111111111".into()),
            basis_points: 6_000,
        },
        Heir {
            label: "Tunde".into(),
            near_account: Some(accounts(4)),
            evm_address: Some("0x2222222222222222222222222222222222222222".into()),
            basis_points: 4_000,
        },
    ]
}

fn slots() -> Vec<ChainSlot> {
    vec![ChainSlot {
        chain: Chain::Evm { chain_id: 11155111 },
        derivation_path: format!("{}/ethereum-1", owner()),
        address: "0x9999999999999999999999999999999999999999".into(),
    }]
}

/// A vigil endowed with 30 days of runway, checking in weekly with a 3-day grace.
fn open(now_ms: u64) -> Vigil {
    let mut c = Vigil::new(signer(), None);
    testing_env!(ctx(owner(), NearToken::from_near(30), now_ms).build());
    c.open_vigil(
        heirs(),
        slots(),
        7 * DAY_MS,
        3 * DAY_MS,
        NearToken::from_near(1),
        U128(100_000_000_000),
        None,
    );
    c
}

fn good_fields(value: u128, to: &str) -> Eip1559Fields {
    Eip1559Fields {
        chain_id: 11155111,
        nonce: 0,
        max_priority_fee_per_gas: U128(1_000_000_000),
        max_fee_per_gas: U128(20_000_000_000),
        gas_limit: 21_000,
        to: to.to_string(),
        value: U128(value),
    }
}

/// Drive the estate into silence and commit a plan over `total` wei.
fn trigger(c: &mut Vigil, now_ms: u64, total: u128) {
    testing_env!(ctx(stranger(), NearToken::from_yoctonear(0), now_ms).build());
    c.declare_silence(owner(), vec![U128(total)]);
}

// ------------------------------------------------------------------ opening

#[test]
fn opening_sets_the_clock_and_the_runway() {
    let c = open(0);
    let s = c.get_status(owner());
    assert_eq!(s.status, EstateStatus::Watching);
    assert_eq!(s.agent_state, AgentState::Alive);
    assert_eq!(s.runway_ms, 30 * DAY_MS, "30 NEAR at 1 NEAR/day is 30 days");
    assert_eq!(s.silent_at_ms, 10 * DAY_MS, "7 day interval + 3 day grace");
    assert!(!s.is_silent);
}

#[test]
#[should_panic(expected = "sum to exactly 10000")]
fn heir_shares_must_account_for_the_whole_estate() {
    let mut c = Vigil::new(signer(), None);
    let mut h = heirs();
    h[0].basis_points = 5_000; // now totals 9000
    testing_env!(ctx(owner(), NearToken::from_near(30), 0).build());
    c.open_vigil(h, slots(), DAY_MS, DAY_MS, NearToken::from_near(1), U128(1), None);
}

#[test]
#[should_panic(expected = "malformed EVM address")]
fn a_malformed_heir_address_is_refused_at_open_time() {
    let mut c = Vigil::new(signer(), None);
    let mut h = heirs();
    h[0].evm_address = Some("0xnope".into());
    testing_env!(ctx(owner(), NearToken::from_near(30), 0).build());
    c.open_vigil(h, slots(), DAY_MS, DAY_MS, NearToken::from_near(1), U128(1), None);
}

/// A vigil that cannot reach its own first deadline is not protection, it is
/// the appearance of protection, so it is refused outright.
#[test]
#[should_panic(expected = "outlast the first check-in window")]
fn a_vigil_that_dies_before_its_first_deadline_is_refused() {
    let mut c = Vigil::new(signer(), None);
    // 1 day of runway against a 2-day window.
    testing_env!(ctx(owner(), NearToken::from_near(1), 0).build());
    c.open_vigil(heirs(), slots(), DAY_MS, DAY_MS, NearToken::from_near(1), U128(1), None);
}

/// ...but a short-horizon vigil is perfectly legal, which is what makes this
/// demonstrable in under two minutes instead of over two days.
#[test]
fn a_vigil_measured_in_seconds_is_allowed() {
    let mut c = Vigil::new(signer(), None);
    // 0.4 N at 864 N/day is 40 seconds of runway, against a 30 second window.
    testing_env!(ctx(owner(), NearToken::from_millinear(400), 0).build());
    let s = c.open_vigil(
        heirs(),
        slots(),
        20_000,
        10_000,
        NearToken::from_near(864),
        U128(100_000_000_000),
        None,
    );
    assert_eq!(s.runway_ms, 40_000);
    assert_eq!(s.silent_at_ms, 30_000);
}

// ----------------------------------------------------------------- mortality

#[test]
fn rent_is_charged_against_elapsed_time() {
    let mut c = open(0);
    testing_env!(ctx(stranger(), NearToken::from_yoctonear(0), 10 * DAY_MS).build());
    let s = c.tick(owner());
    assert_eq!(s.agent_balance, NearToken::from_near(20));
    assert_eq!(s.total_rent_paid, NearToken::from_near(10));
}

#[test]
fn the_agent_starves_when_the_endowment_runs_out() {
    let mut c = open(0);
    testing_env!(ctx(stranger(), NearToken::from_yoctonear(0), 31 * DAY_MS).build());
    let s = c.tick(owner());
    assert_eq!(s.agent_state, AgentState::Starved);
    assert_eq!(s.status, EstateStatus::Lapsed);
    assert_eq!(s.agent_balance, NearToken::from_yoctonear(0));
}

/// The headline safety property. The owner here is unambiguously silent —
/// 31 days without a check-in on a 10-day deadline — but the watchman died
/// first, so nothing moves.
#[test]
#[should_panic(expected = "a dead agent cannot settle an estate")]
fn a_starved_agent_cannot_settle_even_a_genuinely_silent_estate() {
    let mut c = open(0);
    testing_env!(ctx(stranger(), NearToken::from_yoctonear(0), 31 * DAY_MS).build());
    c.tick(owner());
    trigger(&mut c, 31 * DAY_MS, 1_000);
}

#[test]
fn feeding_the_agent_extends_the_watch() {
    let mut c = open(0);
    testing_env!(ctx(stranger(), NearToken::from_near(10), 10 * DAY_MS).build());
    let s = c.feed(owner());
    // 30 endowed, 10 spent, 10 donated.
    assert_eq!(s.agent_balance, NearToken::from_near(30));
    assert_eq!(s.total_donated, NearToken::from_near(10));
    assert_eq!(s.runway_ms, 30 * DAY_MS);
}

/// An heir has every reason to pay for the watchman. That has to be possible
/// without the owner's involvement, or the incentive is worthless.
#[test]
fn anyone_may_feed_someone_elses_agent() {
    let mut c = open(0);
    testing_env!(ctx(accounts(5), NearToken::from_near(5), DAY_MS).build());
    let s = c.feed(owner());
    assert_eq!(s.total_donated, NearToken::from_near(5));
}

#[test]
#[should_panic(expected = "only a lapsed vigil can be reopened")]
fn a_living_vigil_cannot_be_reopened() {
    let mut c = open(0);
    testing_env!(ctx(owner(), NearToken::from_near(10), DAY_MS).build());
    c.reopen_vigil(None);
}

#[test]
fn the_owner_can_revive_a_lapsed_vigil() {
    let mut c = open(0);
    testing_env!(ctx(stranger(), NearToken::from_yoctonear(0), 31 * DAY_MS).build());
    c.tick(owner());
    testing_env!(ctx(owner(), NearToken::from_near(10), 31 * DAY_MS).build());
    let s = c.reopen_vigil(None);
    assert_eq!(s.status, EstateStatus::Watching);
    assert_eq!(s.agent_state, AgentState::Alive);
    assert_eq!(s.last_check_in_ms, 31 * DAY_MS, "reviving counts as being alive");
}

// ------------------------------------------------------------------ silence

#[test]
#[should_panic(expected = "not yet silent")]
fn silence_cannot_be_declared_early() {
    let mut c = open(0);
    trigger(&mut c, 9 * DAY_MS, 1_000); // deadline is day 10
}

#[test]
fn silence_commits_one_leg_per_heir() {
    let mut c = open(0);
    trigger(&mut c, 11 * DAY_MS, 1_000_000_000_000_000_000);
    let s = c.get_status(owner());
    assert_eq!(s.status, EstateStatus::Triggered);
    assert_eq!(s.legs_total, 2);
    assert_eq!(s.legs_signed, 0);

    let estate = c.get_estate(owner()).unwrap();
    let legs = &estate.plans[0].legs;
    assert_eq!(legs[0].value.0, 600_000_000_000_000_000, "Amina's 60%");
    assert_eq!(legs[1].value.0, 400_000_000_000_000_000, "Tunde's 40%");
}

/// "Alive but offline" — the failure case that makes naive dead-man switches
/// dangerous. Checking in must work right up until the last signature.
#[test]
fn checking_in_after_a_trigger_pulls_the_estate_back() {
    let mut c = open(0);
    trigger(&mut c, 11 * DAY_MS, 1_000);
    assert_eq!(c.get_status(owner()).status, EstateStatus::Triggered);

    testing_env!(ctx(owner(), NearToken::from_yoctonear(0), 11 * DAY_MS).build());
    let s = c.check_in();
    assert_eq!(s.status, EstateStatus::Watching);
    assert_eq!(s.legs_total, 0, "the committed plan is discarded");
    assert!(!s.is_silent);
}

#[test]
#[should_panic(expected = "one reported balance is required per chain slot")]
fn a_plan_must_cover_every_chain_slot() {
    let mut c = open(0);
    testing_env!(ctx(stranger(), NearToken::from_yoctonear(0), 11 * DAY_MS).build());
    c.declare_silence(owner(), vec![]);
}

// ------------------------------------------------------- signing safeguards

#[test]
#[should_panic(expected = "recipient does not match the committed settlement plan")]
fn the_contract_refuses_to_redirect_a_payment() {
    let mut c = open(0);
    trigger(&mut c, 11 * DAY_MS, 1_000);
    testing_env!(ctx(stranger(), NearToken::from_yoctonear(1), 11 * DAY_MS).build());
    // A compromised agent pointing Amina's share at itself.
    c.sign_settlement_leg(
        owner(),
        0,
        0,
        good_fields(600, "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
    );
}

#[test]
#[should_panic(expected = "amount does not match the committed settlement plan")]
fn the_contract_refuses_to_inflate_a_payment() {
    let mut c = open(0);
    trigger(&mut c, 11 * DAY_MS, 1_000);
    testing_env!(ctx(stranger(), NearToken::from_yoctonear(1), 11 * DAY_MS).build());
    c.sign_settlement_leg(
        owner(),
        0,
        0,
        good_fields(1_000, "0x1111111111111111111111111111111111111111"),
    );
}

#[test]
#[should_panic(expected = "different chain")]
fn the_contract_refuses_to_sign_for_another_chain() {
    let mut c = open(0);
    trigger(&mut c, 11 * DAY_MS, 1_000);
    let mut fields = good_fields(600, "0x1111111111111111111111111111111111111111");
    fields.chain_id = 1; // mainnet, where the same nonce would be a real transfer
    testing_env!(ctx(stranger(), NearToken::from_yoctonear(1), 11 * DAY_MS).build());
    c.sign_settlement_leg(owner(), 0, 0, fields);
}

#[test]
#[should_panic(expected = "gas price exceeds the cap")]
fn the_contract_refuses_to_burn_the_estate_as_gas() {
    let mut c = open(0);
    trigger(&mut c, 11 * DAY_MS, 1_000);
    let mut fields = good_fields(600, "0x1111111111111111111111111111111111111111");
    fields.max_fee_per_gas = U128(999_000_000_000_000);
    testing_env!(ctx(stranger(), NearToken::from_yoctonear(1), 11 * DAY_MS).build());
    c.sign_settlement_leg(owner(), 0, 0, fields);
}

#[test]
#[should_panic(expected = "no silence declared")]
fn nothing_can_be_signed_before_silence_is_declared() {
    let mut c = open(0);
    testing_env!(ctx(stranger(), NearToken::from_yoctonear(1), DAY_MS).build());
    c.sign_settlement_leg(
        owner(),
        0,
        0,
        good_fields(600, "0x1111111111111111111111111111111111111111"),
    );
}

#[test]
#[should_panic(expected = "attach 1 yoctoNEAR")]
fn signing_requires_the_signer_deposit() {
    let mut c = open(0);
    trigger(&mut c, 11 * DAY_MS, 1_000);
    testing_env!(ctx(stranger(), NearToken::from_yoctonear(0), 11 * DAY_MS).build());
    c.sign_settlement_leg(
        owner(),
        0,
        0,
        good_fields(600, "0x1111111111111111111111111111111111111111"),
    );
}

/// A correctly-formed leg must actually be accepted, or the tests above would
/// pass with a contract that simply refuses everything.
#[test]
fn a_leg_matching_the_plan_is_accepted() {
    let mut c = open(0);
    trigger(&mut c, 11 * DAY_MS, 1_000);
    testing_env!(ctx(stranger(), NearToken::from_yoctonear(1), 11 * DAY_MS).build());
    c.sign_settlement_leg(
        owner(),
        0,
        0,
        good_fields(600, "0x1111111111111111111111111111111111111111"),
    );
    // The promise is dispatched; the leg stays awaiting until the callback.
    assert_eq!(c.get_status(owner()).legs_signed, 0);
}

// ------------------------------------------------------------------ winding

#[test]
fn rent_stops_accruing_once_the_agent_is_executing() {
    let mut c = open(0);
    trigger(&mut c, 11 * DAY_MS, 1_000);
    let before = c.get_status(owner()).agent_balance;
    testing_env!(ctx(stranger(), NearToken::from_yoctonear(0), 60 * DAY_MS).build());
    let after = c.tick(owner()).agent_balance;
    assert_eq!(before, after, "settlement is the job, not more watching");
    assert_eq!(c.get_status(owner()).agent_state, AgentState::Alive);
}

#[test]
fn revoking_clears_the_vigil() {
    let mut c = open(0);
    testing_env!(ctx(owner(), NearToken::from_yoctonear(0), DAY_MS).build());
    c.revoke();
    assert!(c.get_estate(owner()).is_none());
    assert!(c.list_owners().is_empty());
}

#[test]
#[should_panic(expected = "no vigil for that account")]
fn a_stranger_cannot_revoke_someone_elses_vigil() {
    let mut c = open(0);
    testing_env!(ctx(stranger(), NearToken::from_yoctonear(0), DAY_MS).build());
    c.revoke();
}

// ------------------------------------------------------------ path isolation

#[test]
#[should_panic(expected = "derivation path must be the owner's account id")]
fn nobody_can_claim_another_owners_derivation_path() {
    // The estate address depends only on (contract, path). If a stranger could
    // open a vigil over the owner's path, they would control the same address.
    let mut c = open(0);
    testing_env!(ctx(stranger(), NearToken::from_near(30), 0).build());
    c.open_vigil(heirs(), slots(), DAY_MS, DAY_MS, NearToken::from_near(1), U128(1), None);
}

#[test]
#[should_panic(expected = "derivation path must be the owner's account id")]
fn an_unnamespaced_path_is_refused() {
    let mut c = Vigil::new(signer(), None);
    let mut s = slots();
    s[0].derivation_path = "ethereum-1".into();
    testing_env!(ctx(owner(), NearToken::from_near(30), 0).build());
    c.open_vigil(heirs(), s, DAY_MS, DAY_MS, NearToken::from_near(1), U128(1), None);
}

#[test]
#[should_panic(expected = "derivation path must be the owner's account id")]
fn a_bare_prefix_is_not_a_path() {
    let mut c = Vigil::new(signer(), None);
    let mut s = slots();
    s[0].derivation_path = format!("{}/", owner());
    testing_env!(ctx(owner(), NearToken::from_near(30), 0).build());
    c.open_vigil(heirs(), s, DAY_MS, DAY_MS, NearToken::from_near(1), U128(1), None);
}

#[test]
#[should_panic(expected = "each chain slot needs its own derivation path")]
fn two_slots_cannot_share_a_path() {
    let mut c = Vigil::new(signer(), None);
    let s = vec![slots()[0].clone(), slots()[0].clone()];
    testing_env!(ctx(owner(), NearToken::from_near(30), 0).build());
    c.open_vigil(heirs(), s, DAY_MS, DAY_MS, NearToken::from_near(1), U128(1), None);
}

#[test]
fn the_owners_own_namespace_is_accepted() {
    let c = open(0);
    let e = c.get_estate(owner()).unwrap();
    assert_eq!(e.slots[0].derivation_path, format!("{}/ethereum-1", owner()));
}
