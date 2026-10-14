// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// ABI boundary: the pinned OpenVRF router is built separately with Solidity 0.8.28.
interface IOpenVrf {
    function requestFee() external view returns (uint256);
    function requestRandomness(uint32 callbackGasLimit) external payable returns (uint256);
}
