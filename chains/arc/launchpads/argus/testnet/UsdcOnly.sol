// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Test deployment binding for the native USDC path, which never converts assets.
/// @dev Other quote assets fail closed, including if a Portal admin approves one.
contract UsdcOnly {
    address public constant usdc = 0x3600000000000000000000000000000000000000;
    address public immutable poolManager;
    address public immutable stateView;
    error UnsupportedQuote();

    constructor(address pool, address view_) {
        require(block.chainid == 5042002 && pool.code.length != 0 && view_.code.length != 0);
        poolManager = pool;
        stateView = view_;
    }

    fallback() external { revert UnsupportedQuote(); }
}
