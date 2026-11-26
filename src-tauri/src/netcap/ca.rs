//! The capture CA (decrypt mode), generated once with `rcgen`/`ring` into the app config dir
//! (never the OS keychain or `~/.claude`). Only our processes trust it, via `ca-bundle.pem`.
//! On reload the same params are re-self-signed with the stored key (no `x509-parser` needed).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    KeyPair, KeyUsagePurpose, SerialNumber,
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use time::{Duration, OffsetDateTime};

pub const CA_FILE: &str = "ca.pem";
pub const CA_KEY_FILE: &str = "ca-key.pem";
pub const BUNDLE_FILE: &str = "ca-bundle.pem";

const CA_CN: &str = "Agent Studio Capture CA (this machine only)";
const CA_ORG: &str = "Agent Studio";

/// A leaf for one host: the chain to present and its key.
pub struct Leaf {
    pub chain: Vec<CertificateDer<'static>>,
    key_der: Vec<u8>,
}

impl Leaf {
    pub fn key(&self) -> PrivateKeyDer<'static> {
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.key_der.clone()))
    }
}

pub struct Ca {
    issuer: rcgen::Certificate,
    issuer_key: KeyPair,
    /// The PEM clients trust (the file on disk, byte for byte, when loaded).
    ca_pem: String,
    ca_der: CertificateDer<'static>,
    /// One key for every leaf (mitmproxy does the same): minting is then one signature.
    leaf_key: KeyPair,
    leaves: Mutex<HashMap<String, Arc<Leaf>>>,
}

fn ca_params() -> CertificateParams {
    let mut p = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, CA_CN);
    dn.push(DnType::OrganizationName, CA_ORG);
    p.distinguished_name = dn;
    p.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    p.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    let now = OffsetDateTime::now_utc();
    p.not_before = now - Duration::days(1);
    p.not_after = now + Duration::days(3650);
    p
}

fn random_serial() -> SerialNumber {
    let mut b: [u8; 16] = rand::random();
    b[0] &= 0x7f; // positive INTEGER
    SerialNumber::from_slice(&b)
}

fn pem_to_der(pem: &str) -> Result<CertificateDer<'static>, String> {
    use base64::Engine as _;
    let body: String = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect::<Vec<_>>()
        .concat();
    base64::engine::general_purpose::STANDARD
        .decode(body.trim())
        .map(CertificateDer::from)
        .map_err(|e| format!("ca.pem is not PEM: {e}"))
}

/// DER → one PEM `CERTIFICATE` block (64-column base64).
pub fn der_to_pem(der: &[u8]) -> String {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(der);
    let mut out = String::from("-----BEGIN CERTIFICATE-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        out.push('\n');
    }
    out.push_str("-----END CERTIFICATE-----\n");
    out
}

impl Ca {
    /// A fresh in-memory CA (tests; and the first run before it is saved).
    pub fn generate() -> Result<Ca, String> {
        let key = KeyPair::generate().map_err(|e| format!("ca key: {e}"))?;
        let mut params = ca_params();
        params.serial_number = Some(random_serial());
        let cert = params
            .self_signed(&key)
            .map_err(|e| format!("ca cert: {e}"))?;
        let ca_pem = cert.pem();
        let ca_der = cert.der().clone();
        Self::assemble(cert, key, ca_pem, ca_der)
    }

    fn assemble(
        issuer: rcgen::Certificate,
        issuer_key: KeyPair,
        ca_pem: String,
        ca_der: CertificateDer<'static>,
    ) -> Result<Ca, String> {
        Ok(Ca {
            issuer,
            issuer_key,
            ca_pem,
            ca_der,
            leaf_key: KeyPair::generate().map_err(|e| format!("leaf key: {e}"))?,
            leaves: Mutex::new(HashMap::new()),
        })
    }

    /// Load `dir/ca.pem` + `dir/ca-key.pem`, or generate and save them. A pair that fails to
    /// load is replaced (terminals re-read the bundle on every launch anyway).
    pub fn load_or_create(dir: &Path) -> Result<Ca, String> {
        let cert_path = dir.join(CA_FILE);
        let key_path = dir.join(CA_KEY_FILE);
        if let (Ok(pem), Ok(key_pem)) = (
            std::fs::read_to_string(&cert_path),
            std::fs::read_to_string(&key_path),
        ) {
            if let Ok(ca) = Self::from_pems(&pem, &key_pem) {
                return Ok(ca);
            }
        }
        let ca = Self::generate()?;
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        write_private(&key_path, ca.issuer_key.serialize_pem().as_bytes())?;
        std::fs::write(&cert_path, ca.ca_pem.as_bytes())
            .map_err(|e| format!("write {}: {e}", cert_path.display()))?;
        Ok(ca)
    }

    fn from_pems(ca_pem: &str, key_pem: &str) -> Result<Ca, String> {
        let key = KeyPair::from_pem(key_pem).map_err(|e| format!("ca key: {e}"))?;
        let ca_der = pem_to_der(ca_pem)?;
        // Re-self-sign the same DN with the same key: same issuer name + key id as ca.pem.
        let issuer = ca_params()
            .self_signed(&key)
            .map_err(|e| format!("ca reload: {e}"))?;
        Self::assemble(issuer, key, ca_pem.to_string(), ca_der)
    }

    pub fn ca_pem(&self) -> &str {
        &self.ca_pem
    }

    pub fn ca_der(&self) -> &CertificateDer<'static> {
        &self.ca_der
    }

    /// The leaf for `host` (a DNS name or an IP literal), minted once and cached.
    pub fn leaf_for(&self, host: &str) -> Result<Arc<Leaf>, String> {
        let key = host.to_ascii_lowercase();
        if let Some(l) = self.leaves.lock().ok().and_then(|m| m.get(&key).cloned()) {
            return Ok(l);
        }
        let mut p = CertificateParams::new(vec![key.clone()])
            .map_err(|e| format!("leaf params for {host}: {e}"))?;
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, key.as_str());
        p.distinguished_name = dn;
        p.is_ca = IsCa::NoCa;
        p.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        p.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        p.use_authority_key_identifier_extension = true;
        p.serial_number = Some(random_serial());
        let now = OffsetDateTime::now_utc();
        p.not_before = now - Duration::days(1);
        p.not_after = now + Duration::days(365);
        let cert = p
            .signed_by(&self.leaf_key, &self.issuer, &self.issuer_key)
            .map_err(|e| format!("leaf for {host}: {e}"))?;
        let leaf = Arc::new(Leaf {
            chain: vec![cert.der().clone()],
            key_der: self.leaf_key.serialize_der(),
        });
        if let Ok(mut m) = self.leaves.lock() {
            m.insert(key, leaf.clone());
        }
        Ok(leaf)
    }
}

/// Write a secret file readable by the owner only.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write as _;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }
    let mut f = opts
        .open(path)
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    // `mode` only applies on create; tighten a pre-existing file too.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    f.write_all(bytes)
        .map_err(|e| format!("write {}: {e}", path.display()))
}

/// The OS trust anchors ∪ the bundled Mozilla set — the app's trust policy (Cargo.toml TLS
/// block, axis 2). Reads anchors only (no keychain credential, no OS permission prompt).
pub fn system_anchors() -> Vec<CertificateDer<'static>> {
    let mut out = rustls_native_certs::load_native_certs().certs;
    out.extend(webpki_root_certs::TLS_SERVER_ROOT_CERTS.iter().cloned());
    out
}

/// Why a trust anchor is left out of `ca-bundle.pem` ([`bundle_verdict`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Excluded {
    /// Not a DER certificate we can walk.
    Unparseable,
    /// Signed with MD2 / MD4 / MD5 (named).
    WeakDigest(&'static str),
    /// Self-issued, with an algorithm we can check, and its own signature does not verify.
    BadSelfSignature,
}

/// One DER TLV: (tag, content, the whole TLV, what follows).
type Tlv<'a> = (u8, &'a [u8], &'a [u8], &'a [u8]);

/// One DER TLV at the start of `b`. Definite lengths up to 4 length bytes; anything else is
/// `None`.
fn tlv(b: &[u8]) -> Option<Tlv<'_>> {
    let tag = *b.first()?;
    let first = *b.get(1)? as usize;
    let (len, head) = if first < 0x80 {
        (first, 2)
    } else {
        let n = first & 0x7f;
        if n == 0 || n > 4 {
            return None;
        }
        let mut len = 0usize;
        for i in 0..n {
            len = (len << 8) | *b.get(2 + i)? as usize;
        }
        (len, 2 + n)
    };
    let end = head.checked_add(len)?;
    let whole = b.get(..end)?;
    Some((tag, &whole[head..], whole, &b[end..]))
}

const SEQ: u8 = 0x30;
const OID: u8 = 0x06;
const BIT_STRING: u8 = 0x03;
const INTEGER: u8 = 0x02;

/// The OID bytes of an `AlgorithmIdentifier` (and its parameters' first TLV, if an OID).
fn algorithm(alg_id: &[u8]) -> Option<(&[u8], Option<&[u8]>)> {
    let (tag, content, _, _) = tlv(alg_id)?;
    if tag != SEQ {
        return None;
    }
    let (t, oid, _, rest) = tlv(content)?;
    if t != OID {
        return None;
    }
    let param = tlv(rest).filter(|(t, ..)| *t == OID).map(|(_, p, ..)| p);
    Some((oid, param))
}

/// `1.2.840.113549.1.1.<n>` (PKCS #1) — the `<n>` of an RSA signature OID.
fn pkcs1(oid: &[u8]) -> Option<u8> {
    const PREFIX: [u8; 8] = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01];
    (oid.len() == 9 && oid[..8] == PREFIX).then(|| oid[8])
}

const ECDSA_SHA256: [u8; 8] = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
const ECDSA_SHA384: [u8; 8] = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03];
const P256: [u8; 8] = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const P384: [u8; 5] = [0x2b, 0x81, 0x04, 0x00, 0x22];

/// A BIT STRING's bytes (whole bytes only).
fn bits(bit_string: &[u8]) -> Option<&[u8]> {
    match bit_string.split_first() {
        Some((0, rest)) => Some(rest),
        _ => None,
    }
}

/// The modulus size of an `RSAPublicKey` in bits.
fn rsa_bits(rsa_public_key: &[u8]) -> Option<usize> {
    let (t, content, _, _) = tlv(rsa_public_key)?;
    let (ti, n, _, _) = tlv(content)?;
    if t != SEQ || ti != INTEGER {
        return None;
    }
    let n = match n.split_first() {
        Some((0, rest)) => rest,
        _ => n,
    };
    let lead = *n.first()?;
    Some(n.len() * 8 - lead.leading_zeros() as usize)
}

/// Whether a native trust anchor may go in `ca-bundle.pem` (read by every client): out if not
/// walkable DER, MD2/4/5-signed, or a self-issued root whose `ring`-checkable signature fails.
/// Anything we can't judge is KEPT: dropping a needed root breaks a client.
pub fn bundle_verdict(der: &[u8]) -> Result<(), Excluded> {
    use ring::signature as sig;
    let bad = Excluded::Unparseable;
    let (t, cert, _, _) = tlv(der).ok_or(bad)?;
    let (tt, tbs, tbs_raw, rest) = tlv(cert).ok_or(bad)?;
    let (ta, _, alg_raw, rest) = tlv(rest).ok_or(bad)?;
    let (ts, sig_bits, _, _) = tlv(rest).ok_or(bad)?;
    if t != SEQ || tt != SEQ || ta != SEQ || ts != BIT_STRING {
        return Err(bad);
    }
    let (oid, _) = algorithm(alg_raw).ok_or(bad)?;
    match pkcs1(oid) {
        Some(2) => return Err(Excluded::WeakDigest("MD2")),
        Some(3) => return Err(Excluded::WeakDigest("MD4")),
        Some(4) => return Err(Excluded::WeakDigest("MD5")),
        _ => {}
    }
    // tbsCertificate: [0] version?, serial, signature, issuer, validity, subject, spki, …
    let mut f = tbs;
    if f.first() == Some(&0xa0) {
        f = tlv(f).ok_or(bad)?.3;
    }
    let mut field = || -> Result<&[u8], Excluded> {
        let (_, _, whole, rest) = tlv(f).ok_or(bad)?;
        f = rest;
        Ok(whole)
    };
    let _serial = field()?;
    let _inner_alg = field()?;
    let issuer = field()?;
    let _validity = field()?;
    let subject = field()?;
    let spki = field()?;
    if issuer != subject {
        return Ok(()); // not self-issued: its signature is its issuer's business
    }
    let (_, spki_content, _, _) = tlv(spki).ok_or(bad)?;
    let (_, _, key_alg, rest) = tlv(spki_content).ok_or(bad)?;
    let (_, key_bits, _, _) = tlv(rest).ok_or(bad)?;
    let key = bits(key_bits).ok_or(bad)?;
    let signature = bits(sig_bits).ok_or(bad)?;
    let (_, curve) = algorithm(key_alg).ok_or(bad)?;
    let rsa_size = || rsa_bits(key).unwrap_or(0);
    let alg: &dyn sig::VerificationAlgorithm = match (pkcs1(oid), oid, curve) {
        (Some(_), ..) if !(1024..=8192).contains(&rsa_size()) => return Ok(()),
        (Some(5), ..) => &sig::RSA_PKCS1_1024_8192_SHA1_FOR_LEGACY_USE_ONLY,
        (Some(11), ..) => &sig::RSA_PKCS1_1024_8192_SHA256_FOR_LEGACY_USE_ONLY,
        (Some(12), ..) if rsa_size() >= 2048 => &sig::RSA_PKCS1_2048_8192_SHA384,
        (Some(13), ..) => &sig::RSA_PKCS1_1024_8192_SHA512_FOR_LEGACY_USE_ONLY,
        (None, o, Some(c)) if o == ECDSA_SHA256 && c == P256 => &sig::ECDSA_P256_SHA256_ASN1,
        (None, o, Some(c)) if o == ECDSA_SHA384 && c == P256 => &sig::ECDSA_P256_SHA384_ASN1,
        (None, o, Some(c)) if o == ECDSA_SHA256 && c == P384 => &sig::ECDSA_P384_SHA256_ASN1,
        (None, o, Some(c)) if o == ECDSA_SHA384 && c == P384 => &sig::ECDSA_P384_SHA384_ASN1,
        _ => return Ok(()), // an algorithm we cannot check: keep it
    };
    sig::UnparsedPublicKey::new(alg, key)
        .verify(tbs_raw, signature)
        .map_err(|_| Excluded::BadSelfSignature)
}

/// Write `dir/ca-bundle.pem` = `anchors` + our CA, atomically. Returns its path. Anchors that
/// [`bundle_verdict`] rejects are left out (their count is logged).
pub fn write_bundle(
    dir: &Path,
    anchors: &[CertificateDer<'_>],
    ca: &Ca,
) -> Result<PathBuf, String> {
    let mut pem = String::new();
    let mut excluded = 0usize;
    for a in anchors {
        match bundle_verdict(a) {
            Ok(()) => pem.push_str(&der_to_pem(a)),
            Err(_) => excluded += 1,
        }
    }
    if excluded > 0 {
        eprintln!("netcap: {excluded} unusable trust anchor(s) left out of {BUNDLE_FILE}");
    }
    pem.push_str(ca.ca_pem());
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = dir.join(BUNDLE_FILE);
    let tmp = dir.join(format!("{BUNDLE_FILE}.tmp"));
    std::fs::write(&tmp, pem).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename {}: {e}", path.display()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::client::danger::ServerCertVerifier;
    use rustls::pki_types::{ServerName, UnixTime};

    fn verify(ca_der: &CertificateDer<'static>, leaf: &Leaf, name: &str) -> Result<(), String> {
        crate::tls::install_crypto_provider();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(ca_der.clone()).map_err(|e| e.to_string())?;
        let v = rustls::client::WebPkiServerVerifier::builder(Arc::new(roots))
            .build()
            .map_err(|e| e.to_string())?;
        v.verify_server_cert(
            &leaf.chain[0],
            &[],
            &ServerName::try_from(name.to_string()).unwrap(),
            &[],
            UnixTime::now(),
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    fn tmp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("netcap-ca-{}", ulid::Ulid::new()))
    }

    #[test]
    fn a_leaf_verifies_against_the_ca_for_its_own_name_only() {
        let ca = Ca::generate().unwrap();
        let leaf = ca.leaf_for("api.anthropic.com").unwrap();
        verify(ca.ca_der(), &leaf, "api.anthropic.com").unwrap();
        let wrong = verify(ca.ca_der(), &leaf, "example.com").unwrap_err();
        assert!(wrong.contains("not valid for name"), "{wrong}");
    }

    #[test]
    fn an_ip_literal_gets_an_ip_san() {
        let ca = Ca::generate().unwrap();
        let leaf = ca.leaf_for("127.0.0.1").unwrap();
        verify(ca.ca_der(), &leaf, "127.0.0.1").unwrap();
    }

    #[test]
    fn a_leaf_does_not_verify_against_a_different_ca() {
        let ca = Ca::generate().unwrap();
        let other = Ca::generate().unwrap();
        let leaf = ca.leaf_for("h.example").unwrap();
        let err = verify(other.ca_der(), &leaf, "h.example").unwrap_err();
        assert!(
            err.contains("UnknownIssuer") || err.contains("BadSignature"),
            "{err}"
        );
    }

    #[test]
    fn leaves_are_cached_per_host() {
        let ca = Ca::generate().unwrap();
        let a = ca.leaf_for("a.example").unwrap();
        let a2 = ca.leaf_for("A.example").unwrap();
        let b = ca.leaf_for("b.example").unwrap();
        assert!(Arc::ptr_eq(&a, &a2));
        assert!(!Arc::ptr_eq(&a, &b));
        assert_ne!(a.chain[0], b.chain[0]);
    }

    #[test]
    fn a_reloaded_ca_signs_leaves_that_chain_to_the_ca_on_disk() {
        let dir = tmp_dir();
        let first = Ca::load_or_create(&dir).unwrap();
        let on_disk = std::fs::read_to_string(dir.join(CA_FILE)).unwrap();
        assert_eq!(on_disk, first.ca_pem());
        drop(first);
        let second = Ca::load_or_create(&dir).unwrap();
        assert_eq!(second.ca_pem(), on_disk, "reload must not regenerate");
        let leaf = second.leaf_for("reloaded.example").unwrap();
        verify(&pem_to_der(&on_disk).unwrap(), &leaf, "reloaded.example").unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn the_ca_key_is_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tmp_dir();
        Ca::load_or_create(&dir).unwrap();
        let mode = std::fs::metadata(dir.join(CA_KEY_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_corrupt_pair_is_replaced_not_fatal() {
        let dir = tmp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(CA_FILE), "junk").unwrap();
        std::fs::write(dir.join(CA_KEY_FILE), "junk").unwrap();
        let ca = Ca::load_or_create(&dir).unwrap();
        assert!(ca.ca_pem().starts_with("-----BEGIN CERTIFICATE-----"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A PUBLIC root from this Windows VM's own trust store (thumbprint
    /// 742C3192E607E424EB4549542BE1BBC53E6174E2): "VeriSign Class 3 Public Primary Certification
    /// Authority", 1996–2028, md2WithRSA — the certificate that was in `ca-bundle.pem`.
    const VERISIGN_MD2_ROOT: &str = "-----BEGIN CERTIFICATE-----
MIICPDCCAaUCEHC65B0Q2Sk0tjjKewPMur8wDQYJKoZIhvcNAQECBQAwXzELMAkG
A1UEBhMCVVMxFzAVBgNVBAoTDlZlcmlTaWduLCBJbmMuMTcwNQYDVQQLEy5DbGFz
cyAzIFB1YmxpYyBQcmltYXJ5IENlcnRpZmljYXRpb24gQXV0aG9yaXR5MB4XDTk2
MDEyOTAwMDAwMFoXDTI4MDgwMTIzNTk1OVowXzELMAkGA1UEBhMCVVMxFzAVBgNV
BAoTDlZlcmlTaWduLCBJbmMuMTcwNQYDVQQLEy5DbGFzcyAzIFB1YmxpYyBQcmlt
YXJ5IENlcnRpZmljYXRpb24gQXV0aG9yaXR5MIGfMA0GCSqGSIb3DQEBAQUAA4GN
ADCBiQKBgQDJXFme8huKARS0EN8EQNvjV69qRUCPhAwL0TPZ2RHP7gJYHyX3KqhE
BarsAx94f56TuZoAqiN91qyFomNFx3InzPRMxnVx0jnvT0Lwdd8KkMaOIG+YD/is
I19wKTakyYbnsZogy1Olhec9vn2a/iRFM9x2Fe0PonFkTGUugWhFpwIDAQABMA0G
CSqGSIb3DQEBAgUAA4GBALtMEivPLCYATxQT3ab7/AoRhIzzKBxnki98tsX63/Do
lbwdj2wsqFHMc9ikwFPwTtYmwHYBV4GSXiHx0bH/59AhWM1pF+NEHJwZRDmJXNyc
AA9WjQKZ7aKQRUzkuxCkPfAyAw7xzvjoyVGM5mKf5p/AfbdynMk2OmufTqj/ZA1k
-----END CERTIFICATE-----
";

    /// Also public, from the same store (18F7C1FCC3090203FD5BAA2F861A754976C8DD25): "VeriSign
    /// Time Stamping Service Root", md5WithRSA.
    const VERISIGN_MD5_ROOT: &str = "-----BEGIN CERTIFICATE-----
MIICvDCCAiUCEEoZ0jiMglkcpV1zXxVd3KMwDQYJKoZIhvcNAQEEBQAwgZ4xHzAd
BgNVBAoTFlZlcmlTaWduIFRydXN0IE5ldHdvcmsxFzAVBgNVBAsTDlZlcmlTaWdu
LCBJbmMuMSwwKgYDVQQLEyNWZXJpU2lnbiBUaW1lIFN0YW1waW5nIFNlcnZpY2Ug
Um9vdDE0MDIGA1UECxMrTk8gTElBQklMSVRZIEFDQ0VQVEVELCAoYyk5NyBWZXJp
U2lnbiwgSW5jLjAeFw05NzA1MTIwMDAwMDBaFw0wNDAxMDcyMzU5NTlaMIGeMR8w
HQYDVQQKExZWZXJpU2lnbiBUcnVzdCBOZXR3b3JrMRcwFQYDVQQLEw5WZXJpU2ln
biwgSW5jLjEsMCoGA1UECxMjVmVyaVNpZ24gVGltZSBTdGFtcGluZyBTZXJ2aWNl
IFJvb3QxNDAyBgNVBAsTK05PIExJQUJJTElUWSBBQ0NFUFRFRCwgKGMpOTcgVmVy
aVNpZ24sIEluYy4wgZ8wDQYJKoZIhvcNAQEBBQADgY0AMIGJAoGBANMuIPBofCwt
LoEcsQaypwu3EQ1X2lPYdePJMyqy1PYJWzTz6ZD+CQzQ2xtauc3n9oixncCHJet9
WBBzanjLcRX9xlj2KatYXpYE/S1iEViBHMpxlNUiWC/VzBQFhDa6lKq0TUrp7jsi
rVaZfiGcbIbASkeXarSmNtX8CS3TtDmbAgMBAAEwDQYJKoZIhvcNAQEEBQADgYEA
YVUOPnvHkhJ+ERCOIszUsxMrW+hE5At4nqR+86cHch7iWe/MhOOJlEzbTmHvs6T7
Rj1QNAufcFb2jip/F87lY795aQdzLrCVKIr17aqp0l3NCsoQCY/Os68olsR5KYSS
3P+6Z0JIppAQ5L9h+JxT5ZPRcz/4/Z1PhKxV0f0RY2M=
-----END CERTIFICATE-----
";

    #[test]
    fn md2_and_md5_roots_are_excluded_by_name() {
        let md2 = pem_to_der(VERISIGN_MD2_ROOT).unwrap();
        assert_eq!(bundle_verdict(&md2), Err(Excluded::WeakDigest("MD2")));
        let md5 = pem_to_der(VERISIGN_MD5_ROOT).unwrap();
        assert_eq!(bundle_verdict(&md5), Err(Excluded::WeakDigest("MD5")));
    }

    /// Every root of the bundled Mozilla set (real RSA and ECDSA roots, SHA-256/384) is a
    /// self-issued certificate whose own signature verifies — none may be dropped. And our own
    /// CA (rcgen, ECDSA P-256), and a leaf it signed (not self-issued), are kept.
    #[test]
    fn real_roots_our_ca_and_a_leaf_are_kept() {
        let mozilla = webpki_root_certs::TLS_SERVER_ROOT_CERTS;
        assert!(mozilla.len() > 100);
        for (i, c) in mozilla.iter().enumerate() {
            assert_eq!(bundle_verdict(c), Ok(()), "Mozilla root #{i}");
        }
        let ca = Ca::generate().unwrap();
        assert_eq!(bundle_verdict(ca.ca_der()), Ok(()));
        let leaf = ca.leaf_for("h.example").unwrap();
        assert_eq!(bundle_verdict(&leaf.chain[0]), Ok(()));
    }

    /// The self-signature is really checked: one flipped bit in it (or in the signed part) of
    /// a real RSA root and of our ECDSA CA, and the root is out. Junk is out.
    #[test]
    fn a_root_whose_own_signature_fails_or_that_does_not_parse_is_excluded() {
        let rsa = webpki_root_certs::TLS_SERVER_ROOT_CERTS
            .iter()
            .find(|c| {
                c.windows(9)
                    .any(|w| w == [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b])
            })
            .expect("a sha256WithRSA root")
            .to_vec();
        let ecdsa = Ca::generate().unwrap().ca_der().to_vec();
        for good in [rsa, ecdsa] {
            let mut last = good.clone();
            *last.last_mut().unwrap() ^= 0x01;
            assert_eq!(bundle_verdict(&last), Err(Excluded::BadSelfSignature));
            // A bit inside tbsCertificate (well past the outer headers).
            let mut body = good.clone();
            body[40] ^= 0x01;
            assert!(bundle_verdict(&body).is_err(), "a changed signed body");
            assert_eq!(bundle_verdict(&good), Ok(()));
        }
        for junk in [
            &b""[..],
            b"\x30",
            b"\x30\x84\xff\xff\xff\xff",
            b"not a certificate",
        ] {
            assert_eq!(bundle_verdict(junk), Err(Excluded::Unparseable), "{junk:?}");
        }
    }

    /// The bundle written from a store that holds the MD2 root next to good ones has the good
    /// ones and our CA — and not the MD2 root.
    #[test]
    fn the_bundle_leaves_the_md2_root_out() {
        let dir = tmp_dir();
        let ca = Ca::generate().unwrap();
        let good = Ca::generate().unwrap();
        let md2 = pem_to_der(VERISIGN_MD2_ROOT).unwrap();
        let mozilla = webpki_root_certs::TLS_SERVER_ROOT_CERTS[0].clone();
        let anchors = [md2, good.ca_der().clone(), mozilla.clone()];
        let path = write_bundle(&dir, &anchors, &ca).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.matches("BEGIN CERTIFICATE").count(), 3, "{text}");
        assert!(
            !text.contains("MIICPDCCAaUCEHC65B0Q2Sk0tjjKewPMur8w"),
            "MD2 root left out"
        );
        assert!(text.contains(&der_to_pem(&mozilla)));
        assert!(text.contains(&der_to_pem(good.ca_der())));
        assert!(text.ends_with(ca.ca_pem()));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_bundle_holds_the_anchors_then_our_ca() {
        let dir = tmp_dir();
        let ca = Ca::generate().unwrap();
        let anchor = Ca::generate().unwrap();
        let path = write_bundle(&dir, std::slice::from_ref(anchor.ca_der()), &ca).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.matches("BEGIN CERTIFICATE").count(), 2);
        assert!(text.ends_with(ca.ca_pem()));
        // The PEM we hand-roll round-trips to the same DER.
        let first_block = text
            .split_inclusive("-----END CERTIFICATE-----\n")
            .next()
            .unwrap();
        assert_eq!(&pem_to_der(first_block).unwrap(), anchor.ca_der());
        let _ = std::fs::remove_dir_all(dir);
    }
}
