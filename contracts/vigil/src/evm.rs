//! Just enough EVM transaction encoding to let the contract decide for itself
//! what it is signing.
//!
//! This is the hinge of the whole security model. A naive chain-signatures
//! contract accepts a 32-byte hash from its agent and asks the MPC network to
//! sign it — which means a compromised agent can drain everything the estate
//! controls on every chain. Here the contract is handed the *fields* of the
//! transaction instead, re-encodes them, and signs the hash it computed
//! rather than the one it was given. An agent that wants to steal has to
//! produce a transaction that the committed settlement plan already allows,
//! which is to say: it cannot.

use near_sdk::env;

/// Minimal RLP encoding. Only the two cases a transaction needs: byte strings
/// and lists of already-encoded items.
pub mod rlp {
    /// Encode a byte string.
    pub fn bytes(input: &[u8]) -> Vec<u8> {
        if input.len() == 1 && input[0] < 0x80 {
            return vec![input[0]];
        }
        let mut out = length_prefix(input.len(), 0x80);
        out.extend_from_slice(input);
        out
    }

    /// Encode a list whose items are already RLP-encoded.
    pub fn list(items: &[Vec<u8>]) -> Vec<u8> {
        let payload: Vec<u8> = items.concat();
        let mut out = length_prefix(payload.len(), 0xc0);
        out.extend_from_slice(&payload);
        out
    }

    /// Encode an unsigned integer as a big-endian byte string with no leading
    /// zeros. Zero is the empty string, which is RLP's canonical form and the
    /// single most common source of "invalid signature" bugs when hand-rolled.
    pub fn uint(value: u128) -> Vec<u8> {
        if value == 0 {
            return bytes(&[]);
        }
        let be = value.to_be_bytes();
        let first = be.iter().position(|b| *b != 0).unwrap_or(be.len() - 1);
        bytes(&be[first..])
    }

    fn length_prefix(len: usize, offset: u8) -> Vec<u8> {
        if len <= 55 {
            return vec![offset + len as u8];
        }
        let be = len.to_be_bytes();
        let first = be.iter().position(|b| *b != 0).unwrap_or(be.len() - 1);
        let len_bytes = &be[first..];
        let mut out = vec![offset + 55 + len_bytes.len() as u8];
        out.extend_from_slice(len_bytes);
        out
    }
}

/// The fields of an EIP-1559 (type 2) transaction, as submitted by the agent.
///
/// Every one of these is re-encoded by the contract. None of them is trusted
/// to describe a hash supplied alongside.
#[derive(Clone, Debug)]
#[near_sdk::near(serializers = [json])]
pub struct Eip1559Fields {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: near_sdk::json_types::U128,
    pub max_fee_per_gas: near_sdk::json_types::U128,
    pub gas_limit: u64,
    /// Lowercase `0x`-prefixed 20-byte recipient.
    pub to: String,
    pub value: near_sdk::json_types::U128,
}

/// Parse a `0x`-prefixed 20-byte hex address.
pub fn parse_address(address: &str) -> Result<[u8; 20], &'static str> {
    let stripped = address
        .strip_prefix("0x")
        .or_else(|| address.strip_prefix("0X"))
        .ok_or("address must be 0x-prefixed")?;
    if stripped.len() != 40 {
        return Err("address must be 20 bytes");
    }
    let raw = hex::decode(stripped).map_err(|_| "address is not valid hex")?;
    let mut out = [0u8; 20];
    out.copy_from_slice(&raw);
    Ok(out)
}

/// Two addresses are the same address regardless of checksum casing.
pub fn addresses_match(a: &str, b: &str) -> bool {
    match (parse_address(a), parse_address(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

impl Eip1559Fields {
    /// The payload the MPC network must sign:
    /// `keccak256(0x02 || rlp([chainId, nonce, maxPriorityFee, maxFee, gas, to, value, data, accessList]))`
    ///
    /// `data` and `accessList` are always empty here: a settlement is a plain
    /// value transfer to an heir. Refusing to encode calldata at all removes
    /// the entire class of "the agent asked us to sign a contract call" attack.
    pub fn signing_hash(&self) -> Result<[u8; 32], &'static str> {
        let to = parse_address(&self.to)?;

        let encoded = rlp::list(&[
            rlp::uint(self.chain_id as u128),
            rlp::uint(self.nonce as u128),
            rlp::uint(self.max_priority_fee_per_gas.0),
            rlp::uint(self.max_fee_per_gas.0),
            rlp::uint(self.gas_limit as u128),
            rlp::bytes(&to),
            rlp::uint(self.value.0),
            rlp::bytes(&[]),   // data: empty
            rlp::list(&[]),    // accessList: empty
        ]);

        let mut payload = Vec::with_capacity(encoded.len() + 1);
        payload.push(0x02);
        payload.extend_from_slice(&encoded);

        let digest = env::keccak256(&payload);
        let mut out = [0u8; 32];
        out.copy_from_slice(&digest);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::json_types::U128;

    #[test]
    fn rlp_encodes_zero_as_empty_string() {
        assert_eq!(rlp::uint(0), vec![0x80]);
    }

    #[test]
    fn rlp_strips_leading_zeros() {
        assert_eq!(rlp::uint(1), vec![0x01]);
        assert_eq!(rlp::uint(0x7f), vec![0x7f]);
        assert_eq!(rlp::uint(0x80), vec![0x81, 0x80]);
        assert_eq!(rlp::uint(1024), vec![0x82, 0x04, 0x00]);
    }

    #[test]
    fn rlp_encodes_short_and_long_strings() {
        assert_eq!(rlp::bytes(&[]), vec![0x80]);
        assert_eq!(rlp::bytes(&[0xaa, 0xbb]), vec![0x82, 0xaa, 0xbb]);
        let long = vec![0x11u8; 56];
        let encoded = rlp::bytes(&long);
        assert_eq!(encoded[0], 0xb8);
        assert_eq!(encoded[1], 56);
    }

    #[test]
    fn address_parsing_rejects_malformed_input() {
        assert!(parse_address("0x0000000000000000000000000000000000000001").is_ok());
        assert!(parse_address("0000000000000000000000000000000000000001").is_err());
        assert!(parse_address("0xdeadbeef").is_err());
        assert!(parse_address("0xzz00000000000000000000000000000000000001").is_err());
    }

    #[test]
    fn addresses_match_ignores_checksum_casing() {
        assert!(addresses_match(
            "0xAbC0000000000000000000000000000000000001",
            "0xabc0000000000000000000000000000000000001"
        ));
        assert!(!addresses_match(
            "0xabc0000000000000000000000000000000000001",
            "0xabc0000000000000000000000000000000000002"
        ));
    }

    /// Changing any field must change the hash. This is what stops an agent
    /// from re-pointing a plan-approved transfer at its own address.
    #[test]
    fn every_field_is_bound_into_the_hash() {
        let base = Eip1559Fields {
            chain_id: 11155111,
            nonce: 0,
            max_priority_fee_per_gas: U128(1_000_000_000),
            max_fee_per_gas: U128(30_000_000_000),
            gas_limit: 21_000,
            to: "0x1111111111111111111111111111111111111111".to_string(),
            value: U128(1_000_000_000_000_000_000),
        };
        let baseline = base.signing_hash().unwrap();

        let mut other_recipient = base.clone();
        other_recipient.to = "0x2222222222222222222222222222222222222222".to_string();
        assert_ne!(baseline, other_recipient.signing_hash().unwrap());

        let mut other_value = base.clone();
        other_value.value = U128(2_000_000_000_000_000_000);
        assert_ne!(baseline, other_value.signing_hash().unwrap());

        let mut other_chain = base.clone();
        other_chain.chain_id = 1;
        assert_ne!(baseline, other_chain.signing_hash().unwrap());

        let mut other_nonce = base.clone();
        other_nonce.nonce = 1;
        assert_ne!(baseline, other_nonce.signing_hash().unwrap());
    }
}
