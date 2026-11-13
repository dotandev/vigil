//! The chain-signatures interface.
//!
//! Wire format verified against `near/mpc` at
//! `crates/near-mpc-contract-interface/src/snapshots/..._wire_format_catalog.snap`:
//!
//! ```json
//! {"request":{"path":"test","payload_v2":{"Ecdsa":"0707..."},"domain_id":0}}
//! ```
//!
//! Note `payload_v2`, not `payload` — the Rust field is named `payload` and
//! renamed on the wire, so reading the struct definition alone misleads you.
//! The deposit is exactly 1 yoctoNEAR (`SIGN_DEPOSIT_YOCTONEAR`).

use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{ext_contract, Gas, NearToken};

/// `0` selects the Secp256k1 signing domain, which is what every EVM chain
/// and Bitcoin need. `1` would be Ed25519.
pub const SECP256K1_DOMAIN_ID: u32 = 0;

/// Fixed by the MPC contract.
pub const SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);

/// The signer yields and resumes, so this has to cover the full round trip.
pub const SIGN_GAS: Gas = Gas::from_tgas(100);

/// Enough to record a signature and emit an event.
pub const SIGN_CALLBACK_GAS: Gas = Gas::from_tgas(30);

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub enum Payload {
    /// Lowercase hex of the 32-byte digest to sign.
    Ecdsa(String),
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct SignRequestArgs {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u32,
}

impl SignRequestArgs {
    pub fn ecdsa(path: String, digest: &[u8; 32]) -> Self {
        Self {
            path,
            payload_v2: Payload::Ecdsa(hex::encode(digest)),
            domain_id: SECP256K1_DOMAIN_ID,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct AffinePoint {
    pub affine_point: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Scalar {
    pub scalar: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde", tag = "scheme")]
pub enum SignatureResponse {
    Secp256k1 {
        big_r: AffinePoint,
        s: Scalar,
        recovery_id: u8,
    },
}

#[ext_contract(ext_mpc)]
pub trait MpcSigner {
    fn sign(&mut self, request: SignRequestArgs) -> SignatureResponse;
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json;

    /// The exact shape the signer expects. If this test fails, every
    /// settlement fails on-chain with an opaque deserialization error.
    #[test]
    fn sign_request_matches_the_published_wire_format() {
        let digest = [0x07u8; 32];
        let args = SignRequestArgs::ecdsa("ethereum-1".to_string(), &digest);
        let json = serde_json::to_string(&args).unwrap();
        assert_eq!(
            json,
            r#"{"path":"ethereum-1","payload_v2":{"Ecdsa":"0707070707070707070707070707070707070707070707070707070707070707"},"domain_id":0}"#
        );
    }

    #[test]
    fn signature_response_parses_the_signer_reply() {
        let raw = r#"{"scheme":"Secp256k1","big_r":{"affine_point":"070707070707070707070707070707070707070707070707070707070707070707"},"s":{"scalar":"0707070707070707070707070707070707070707070707070707070707070707"},"recovery_id":0}"#;
        let parsed: SignatureResponse = serde_json::from_str(raw).unwrap();
        let SignatureResponse::Secp256k1 { recovery_id, .. } = parsed;
        assert_eq!(recovery_id, 0);
    }
}
