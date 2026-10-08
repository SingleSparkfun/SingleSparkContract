// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BLS} from "../lib/bls-solidity/src/libraries/BLS.sol";

/// @notice Verifies the fixed drand evmnet beacon; no operator can supply an arbitrary seed.
/// @dev Testnet integration of Randamu's experimental, unaudited BN254 verifier.
///      Consumers MUST commit inputs and a future beacon round before its publication time.
contract ArcDrandVerifier {
    bytes32 public constant BEACON_HASH = 0x04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3;
    uint256 public constant GENESIS = 1_727_521_075;
    uint256 public constant PERIOD = 3;

    error InvalidProof();

    /// @notice Earliest beacon round whose scheduled publication is at or after the timestamp.
    function roundAtOrAfter(uint256 timestamp) external pure returns (uint64) {
        if (timestamp <= GENESIS) return 1;
        uint256 elapsed = timestamp - GENESIS;
        uint256 round = elapsed / PERIOD + (elapsed % PERIOD == 0 ? 0 : 1) + 1;
        if (round > type(uint64).max) revert InvalidProof();
        return uint64(round);
    }

    function verify(uint64 round, bytes calldata signature) external view returns (bytes32 randomness) {
        if (round == 0 || signature.length != 64) revert InvalidProof();
        if (block.timestamp < GENESIS + (uint256(round) - 1) * PERIOD) revert InvalidProof();
        BLS.PointG1 memory point = BLS.g1Unmarshal(signature);
        if (!BLS.isValidPointG1(point)) revert InvalidProof();
        // Fixed public key from drand evmnet /info. The upstream marshal reverses each Fp2 pair.
        BLS.PointG2 memory publicKey = BLS.g2Unmarshal(
            hex"07e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b3820557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808f0095685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0b"
        );
        (bool valid, bool success) = BLS.verifySingle(
            point,
            publicKey,
            BLS.hashToPoint(
                bytes("BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_"),
                abi.encodePacked(keccak256(abi.encodePacked(round)))
            )
        );
        if (!success || !valid) revert InvalidProof();
        return sha256(signature);
    }
}
