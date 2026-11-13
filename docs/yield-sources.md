# Yield sources

A vigil's agent has running costs. Something has to pay them, for as long as
the watch lasts — which may be decades. The design answer is that **the estate
pays for its own watchman** out of what it earns, so the vigil does not depend
on anyone remembering to fund it.

The contract talks to a yield source through exactly one method:

```rust
fn harvest_yield(&mut self, account_id: AccountId) -> U128;
```

It transfers everything accrued since the last call to the caller (the vigil
contract) and returns the amount. That is the entire interface.

## What ships in this repo

`contracts/mock-pool` implements it with a per-second accrual rate. It exists
because of a **timing mismatch, not a capability one**: a real NEAR staking
pool pays rewards once per epoch (~12 hours) and locks unstaked NEAR for four
epochs (~48 hours). A demo that waits two days to show one wage payment
demonstrates nothing to anybody watching.

## Using a real staking pool

A real adapter implements the same method over the standard staking-pool
interface:

| Step | Staking pool call | Note |
|---|---|---|
| Refresh rewards | `ping()` | Must be called before balances are accurate |
| Read total | `get_account_total_balance(account_id)` | Principal + rewards |
| Compute yield | — | `total - principal_high_water_mark` |
| Begin withdrawal | `unstake(amount)` | Starts the four-epoch lock |
| Collect | `withdraw(amount)` | Only after the lock elapses |

The consequence is that an adapter must run **two epochs ahead of the agent's
rent**: it unstakes a wage before the agent needs it, not when the balance
hits zero. An adapter that unstakes on demand will let the agent starve while
its own money is locked, which is a safe failure but an embarrassing one.

## Why a hostile yield source cannot steal

The worst a yield source can do is pay less than it promised, or nothing. That
starves the agent, and a starved agent distributes nothing and leaves the
estate untouched. The yield source is never consulted about who inherits, how
much, or whether the owner is silent, so it sits entirely outside the part of
the system that can move value.
