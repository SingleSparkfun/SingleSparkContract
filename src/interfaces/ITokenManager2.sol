// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Documented Four.meme Classic creation surface; not a fee-claim interface.
interface ITokenManager2 {
    function createToken(bytes calldata args, bytes calldata signature) external payable;
    event TokenCreate(address creator, address token, uint256 requestId, string name, string symbol,
        uint256 totalSupply, uint256 launchTime, uint256 launchFee);
}
