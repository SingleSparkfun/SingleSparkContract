// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IPonsLaunch {
    struct LaunchedToken {
        address token; address curve; address deployer; address creatorFeeRecipient; address pairToken;
        uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps;
        bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists;
    }
    struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }
    struct TokenParams {
        string name; string symbol; string logo; string description; Socials socials;
        address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt;
    }
    function launchToken(TokenParams calldata params, uint256 config, address pair, address[] calldata exemptions)
        external payable returns (address token, address curve);
    function feeEscrow() external view returns (address);
    function canLaunch(address launcher) external view returns (bool);
    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
    function memeHook() external view returns (address);
    function poolManager() external view returns (address);
}

interface IPonsEscrow {
    function balanceOf(address recipient) external view returns (uint256);
    function claim() external returns (uint256);
}

interface IPonsCurve {
    function token() external view returns (address);
    function pairToken() external view returns (address);
    function factory() external view returns (address);
    function buy(uint256 amount, uint256 minimumOutput, address recipient) external payable returns (uint256);
    function graduated() external view returns (bool);
    function sweepFees(uint256 minimumOutput) external;
}

interface IPonsVaultFactory {
    function escrow() external view returns (IPonsEscrow);
    function curveOf(address token) external view returns (IPonsCurve);
    function checkPons() external view;
}
