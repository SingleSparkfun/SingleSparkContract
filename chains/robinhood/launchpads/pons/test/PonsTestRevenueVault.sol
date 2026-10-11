// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IPonsTestFeeEscrow {
    function claim() external;
}

/// @dev Testnet acceptance fixture: creator revenue stays in this contract.
/// No withdrawal or gameplay authority; never use for production projects.
contract PonsTestRevenueVault {
    IPonsTestFeeEscrow public immutable escrow;

    constructor(address feeEscrow) {
        require(block.chainid == 46630, "Robinhood testnet only");
        require(feeEscrow.code.length != 0, "Missing escrow");
        escrow = IPonsTestFeeEscrow(feeEscrow);
    }

    function claim() external { escrow.claim(); }
    receive() external payable {}
}
