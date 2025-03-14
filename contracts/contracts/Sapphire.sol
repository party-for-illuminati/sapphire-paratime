// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

/**
 * @title Sapphire
 * @dev Convenient wrapper methods for Sapphire's cryptographic primitives.
 */
library Sapphire {
    // Oasis-specific, confidential precompiles
    address internal constant RANDOM_BYTES =
        0x0100000000000000000000000000000000000001;
    address internal constant DERIVE_KEY =
        0x0100000000000000000000000000000000000002;
    address internal constant ENCRYPT =
        0x0100000000000000000000000000000000000003;
    address internal constant DECRYPT =
        0x0100000000000000000000000000000000000004;
    address internal constant GENERATE_SIGNING_KEYPAIR =
        0x0100000000000000000000000000000000000005;
    address internal constant SIGN_DIGEST =
        0x0100000000000000000000000000000000000006;
    address internal constant VERIFY_DIGEST =
        0x0100000000000000000000000000000000000007;
    address internal constant CURVE25519_PUBLIC_KEY =
        0x0100000000000000000000000000000000000008;
    address internal constant GAS_USED =
        0x0100000000000000000000000000000000000009;
    address internal constant PAD_GAS =
        0x010000000000000000000000000000000000000a;

    // Oasis-specific, general precompiles
    address internal constant SHA512_256 =
        0x0100000000000000000000000000000000000101;
    address internal constant SHA512 =
        0x0100000000000000000000000000000000000102;
    address internal constant SHA384 =
        0x0100000000000000000000000000000000000104;

    type Curve25519PublicKey is bytes32;
    type Curve25519SecretKey is bytes32;

    enum SigningAlg {
        // Ed25519 signature over the provided message using SHA-512/265 with a domain separator.
        // Can be used to sign transactions for the Oasis consensus layer and SDK paratimes.
        Ed25519Oasis,
        // Ed25519 signature over the provided message.
        Ed25519Pure,
        // Ed25519 signature over the provided prehashed SHA-512 digest.
        Ed25519PrehashedSha512,
        // Secp256k1 signature over the provided message using SHA-512/256 with a domain separator.
        // Can be used to sign transactions for the Oasis consensus layer and SDK paratimes.
        Secp256k1Oasis,
        // Secp256k1 over the provided Keccak256 digest.
        // Can be used to sign transactions for Ethereum-compatible networks.
        Secp256k1PrehashedKeccak256,
        // Secp256k1 signature over the provided SHA-256 digest.
        Secp256k1PrehashedSha256,
        // Sr25519 signature over the provided message.
        Sr25519,
        // Secp256r1 signature over the provided SHA-256 digest.
        Secp256r1PrehashedSha256,
        // Secp384r1 signature over the provided SHA-384 digest.
        Secp384r1PrehashedSha384
    }

    /**
     * @dev Returns cryptographically secure random bytes.
     * @param numBytes The number of bytes to return.
     * @param pers An optional personalization string to increase domain separation.
     * @return The random bytes. If the number of bytes requested is too large (over 1024), a smaller amount (1024) will be returned.
     */
    function randomBytes(uint256 numBytes, bytes memory pers)
        internal
        view
        returns (bytes memory)
    {
        (bool success, bytes memory entropy) = RANDOM_BYTES.staticcall(
            abi.encode(numBytes, pers)
        );
        require(success, "randomBytes: failed");
        return entropy;
    }

    /**
     * @dev Generates a Curve25519 keypair.
     * @param pers An optional personalization string used to add domain separation.
     * @return pk The Curve25519 public key. Useful for key exchange.
     * @return sk The Curve25519 secret key. Pairs well with {`deriveSymmetricKey`}.
     */
    function generateCurve25519KeyPair(bytes memory pers)
        internal
        view
        returns (Curve25519PublicKey pk, Curve25519SecretKey sk)
    {
        bytes memory scalar = randomBytes(32, pers);
        // Twiddle some bits, as per RFC 7748 §5.
        scalar[0] &= 0xf8; // Make it a multiple of 8 to avoid small subgroup attacks.
        scalar[31] &= 0x7f; // Clamp to < 2^255 - 19
        scalar[31] |= 0x40; // Clamp to >= 2^254
        (bool success, bytes memory pkBytes) = CURVE25519_PUBLIC_KEY.staticcall(
            scalar
        );
        require(success, "gen curve25519 pk: failed");
        return (
            Curve25519PublicKey.wrap(bytes32(pkBytes)),
            Curve25519SecretKey.wrap(bytes32(scalar))
        );
    }

    /**
     * @dev Derive a symmetric key from a pair of keys using x25519.
     * @param peerPublicKey The peer's public key.
     * @param secretKey Your secret key.
     * @return A derived symmetric key.
     */
    function deriveSymmetricKey(
        Curve25519PublicKey peerPublicKey,
        Curve25519SecretKey secretKey
    ) internal view returns (bytes32) {
        (bool success, bytes memory symmetric) = DERIVE_KEY.staticcall(
            abi.encode(peerPublicKey, secretKey)
        );
        require(success, "deriveSymmetricKey: failed");
        return bytes32(symmetric);
    }

    /**
     * @dev Encrypt and authenticate the plaintext and additional data using DeoxysII.
     * @param key The key to use for encryption.
     * @param nonce The nonce. Note that only the first 15 bytes of this parameter are used.
     * @param plaintext The plaintext to encrypt and authenticate.
     * @param additionalData The additional data to authenticate.
     * @return The ciphertext with appended auth tag.
     */
    function encrypt(
        bytes32 key,
        bytes32 nonce,
        bytes memory plaintext,
        bytes memory additionalData
    ) internal view returns (bytes memory) {
        (bool success, bytes memory ciphertext) = ENCRYPT.staticcall(
            abi.encode(key, nonce, plaintext, additionalData)
        );
        require(success, "encrypt: failed");
        return ciphertext;
    }

    /**
     * @dev Decrypt and authenticate the ciphertext and additional data using DeoxysII. Reverts if the auth tag is incorrect.
     * @param key The key to use for decryption.
     * @param nonce The nonce. Note that only the first 15 bytes of this parameter are used.
     * @param ciphertext The ciphertext with tag to decrypt and authenticate.
     * @param additionalData The additional data to authenticate against the ciphertext.
     * @return The original plaintext.
     */
    function decrypt(
        bytes32 key,
        bytes32 nonce,
        bytes memory ciphertext,
        bytes memory additionalData
    ) internal view returns (bytes memory) {
        (bool success, bytes memory plaintext) = DECRYPT.staticcall(
            abi.encode(key, nonce, ciphertext, additionalData)
        );
        require(success, "decrypt: failed");
        return plaintext;
    }

    /**
     * @dev Generate a public/private key pair using the specified method and seed.
     * @param alg The signing alg for which to generate a keypair.
     * @param seed The seed to use for generating the key pair. You can use the `randomBytes` method if you don't already have a seed.
     * @return publicKey The public half of the keypair.
     * @return secretKey The secret half of the keypair.
     */
    function generateSigningKeyPair(SigningAlg alg, bytes memory seed)
        internal
        view
        returns (bytes memory publicKey, bytes memory secretKey)
    {
        (bool success, bytes memory keypair) = GENERATE_SIGNING_KEYPAIR
            .staticcall(abi.encode(alg, seed));
        require(success, "gen signing keypair: failed");
        return abi.decode(keypair, (bytes, bytes));
    }

    /**
     * @dev Sign a message within the provided context using the specified algorithm, and return the signature.
     * @param alg The signing algorithm to use.
     * @param secretKey The secret key to use for signing. The key must be valid for use with the requested algorithm.
     * @param contextOrHash Domain-Separator Context, or precomputed hash bytes
     * @param message Message to sign, should be zero-length if precomputed hash given
     * @return signature The resulting signature.
     * @custom:see @oasisprotocol/oasis-sdk :: precompile/confidential.rs :: call_sign
     */
    function sign(
        SigningAlg alg,
        bytes memory secretKey,
        bytes memory contextOrHash,
        bytes memory message
    ) internal view returns (bytes memory signature) {
        (bool success, bytes memory sig) = SIGN_DIGEST.staticcall(
            abi.encode(alg, secretKey, contextOrHash, message)
        );
        require(success, "sign: failed");
        return sig;
    }

    /**
     * @dev Verifies that the provided digest was signed with using the secret key corresponding to the provided private key and the specified signing algorithm.
     * @param alg The signing algorithm by which the signature was generated.
     * @param publicKey The public key against which to check the signature.
     * @param contextOrHash Domain-Separator Context, or precomputed hash bytes
     * @param message The hash of the message that was signed, should be zero-length if precomputed hash was given
     * @param signature The signature to check.
     * @return verified Whether the signature is valid for the given parameters.
     * @custom:see @oasisprotocol/oasis-sdk :: precompile/confidential.rs :: call_verify
     */
    function verify(
        SigningAlg alg,
        bytes memory publicKey,
        bytes memory contextOrHash,
        bytes memory message,
        bytes memory signature
    ) internal view returns (bool verified) {
        (bool success, bytes memory v) = VERIFY_DIGEST.staticcall(
            abi.encode(alg, publicKey, contextOrHash, message, signature)
        );
        require(success, "verify: failed");
        return abi.decode(v, (bool));
    }

    /**
     * @dev Set the current transactions gas usage to a specific amount
     * @param toAmount Gas usage will be set to this amount
     * @custom:see @oasisprotocol/oasis-sdk :: precompile/gas.rs :: call_pad_gas
     *
     * Will cause a reversion if the current usage is more than the amount
     */
    function padGas(uint128 toAmount) internal view {
        (bool success, ) = PAD_GAS.staticcall(abi.encode(toAmount));
        require(success, "verify: failed");
    }

    /**
     * @dev Returns the amount of gas currently used by the transaction
     * @custom:see @oasisprotocol/oasis-sdk :: precompile/gas.rs :: call_gas_used
     */
    function gasUsed() internal view returns (uint64) {
        (bool success, bytes memory v) = GAS_USED.staticcall("");
        require(success, "gasused: failed");
        return abi.decode(v, (uint64));
    }
}

/**
 * Hash the input data with SHA-512/256
 *
 * SHA-512 is vulnerable to length-extension attacks, which are relevant if you
 * are computing the hash of a secret message. The SHA-512/256 variant is
 * **not** vulnerable to length-extension attacks.
 *
 * @custom:standard https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf
 * @custom:see @oasisprotocol/oasis-sdk :: precompile/sha2.rs :: call_sha512_256
 * @param input Bytes to hash
 * @return result 32 byte digest
 */
function sha512_256(bytes memory input) view returns (bytes32 result) {
    (bool success, bytes memory output) = Sapphire.SHA512_256.staticcall(input);

    require(success, "sha512_256");

    return bytes32(output);
}

/**
 * Hash the input data with SHA-512
 *
 * @custom:standard https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf
 * @custom:see @oasisprotocol/oasis-sdk :: precompile/sha2.rs :: call_sha512
 * @param input Bytes to hash
 * @return output 64 byte digest
 */
function sha512(bytes memory input) view returns (bytes memory output) {
    bool success;

    (success, output) = Sapphire.SHA512.staticcall(input);

    require(success, "sha512");
}

/**
 * Hash the input data with SHA-384
 *
 * @custom:standard https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf
 * @custom:see @oasisprotocol/oasis-sdk :: precompile/sha2.rs :: call_sha384
 * @param input Bytes to hash
 * @return output 48 byte digest
 */
function sha384(bytes memory input) view returns (bytes memory output) {
    bool success;

    (success, output) = Sapphire.SHA384.staticcall(input);

    require(success, "sha384");
}
