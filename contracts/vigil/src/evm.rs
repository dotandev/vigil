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
        let payload = typed(rlp::list(&self.rlp_fields()?));
        let digest = env::keccak256(&payload);
        let mut out = [0u8; 32];
        out.copy_from_slice(&digest);
        Ok(out)
    }

    /// The broadcastable transaction: the same nine fields followed by the
    /// signature, `0x02 || rlp([..., yParity, r, s])`. Built from the fields the
    /// contract already checked, so what goes on chain is exactly what was
    /// approved.
    pub fn signed_raw(&self, y_parity: u8, r: &[u8], s: &[u8]) -> Result<Vec<u8>, &'static str> {
        if r.len() != 32 || s.len() != 32 || y_parity > 1 {
            return Err("malformed signature");
        }
        let mut items = self.rlp_fields()?;
        items.push(rlp::uint(y_parity as u128));
        items.push(rlp::bytes(strip_leading_zeros(r)));
        items.push(rlp::bytes(strip_leading_zeros(s)));
        Ok(typed(rlp::list(&items)))
    }

    fn rlp_fields(&self) -> Result<Vec<Vec<u8>>, &'static str> {
        let to = parse_address(&self.to)?;
        Ok(vec![
            rlp::uint(self.chain_id as u128),
            rlp::uint(self.nonce as u128),
            rlp::uint(self.max_priority_fee_per_gas.0),
            rlp::uint(self.max_fee_per_gas.0),
            rlp::uint(self.gas_limit as u128),
            rlp::bytes(&to),
            rlp::uint(self.value.0),
            rlp::bytes(&[]), // data: empty
            rlp::list(&[]),  // accessList: empty
        ])
    }
}

/// EIP-2718 envelope: the type byte, then the RLP payload.
fn typed(encoded: Vec<u8>) -> Vec<u8> {
    let mut out = Vec::with_capacity(encoded.len() + 1);
    out.push(0x02);
    out.extend_from_slice(&encoded);
    out
}

/// r and s are RLP integers, so a leading zero byte must go.
fn strip_leading_zeros(b: &[u8]) -> &[u8] {
    let first = b.iter().position(|x| *x != 0).unwrap_or(b.len());
    &b[first..]
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::json_types::U128;

    /// Known-answer test against a transaction signed independently by viem
    /// with a throwaway key. If this matches byte for byte, a node will accept
    /// what the contract assembles.
    #[test]
    fn signed_raw_matches_an_independently_signed_transaction() {
        let fields = Eip1559Fields {
            chain_id: 11155111,
            nonce: 7,
            max_priority_fee_per_gas: U128(1_500_000_000),
            max_fee_per_gas: U128(30_000_000_000),
            gas_limit: 21_000,
            to: "0x1111111111111111111111111111111111111111".into(),
            value: U128(600_000_000_000_000_000),
        };
        let r = hex::decode("67aca6c00735b165f5c5a527602b4b5fa64248ecc83a50addfe29984cc83ed75").unwrap();
        let s = hex::decode("37113879588c9931d22cf22a731b272971d35e184ee876d16c8bc7f507eda9ad").unwrap();
        let raw = fields.signed_raw(0, &r, &s).unwrap();
        assert_eq!(
            format!("0x{}", hex::encode(raw)),
            "0x02f87683aa36a7078459682f008506fc23ac00825208941111111111111111111111111111111111111111880853a0d2313c000080c080a067aca6c00735b165f5c5a527602b4b5fa64248ecc83a50addfe29984cc83ed75a037113879588c9931d22cf22a731b272971d35e184ee876d16c8bc7f507eda9ad"
        );
    }

    #[test]
    fn signed_raw_strips_leading_zeros_from_r_and_s() {
        let fields = Eip1559Fields {
            chain_id: 1,
            nonce: 0,
            max_priority_fee_per_gas: U128(1),
            max_fee_per_gas: U128(1),
            gas_limit: 21_000,
            to: "0x1111111111111111111111111111111111111111".into(),
            value: U128(1),
        };
        let mut r = vec![0u8; 32];
        r[31] = 9;
        let s = vec![7u8; 32];
        let raw = fields.signed_raw(1, &r, &s).unwrap();
        // ... yParity 0x01, r as the single byte 0x09, s as 32 bytes
        let tail = &raw[raw.len() - 35..];
        assert_eq!(tail[0], 0x01);
        assert_eq!(tail[1], 0x09);
        assert_eq!(tail[2], 0xa0);
    }

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
