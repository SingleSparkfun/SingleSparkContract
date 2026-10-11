// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {GameplayVaultFactory} from "../../../evm/gameplay/GameplayVaultFactory.sol";
import {GameplayPolicy, IGameplayFactory} from "../../../evm/gameplay/IGameplayProtocol.sol";
import {PonsGameplayVault} from "./PonsGameplayVault.sol";
import {IPonsLaunch, IPonsEscrow, IPonsCurve} from "./IPonsLaunch.sol";

/// Atomic native-ETH Pons launch and isolated project custody on Robinhood Testnet.
contract PonsVaultFactory is GameplayVaultFactory {
    IPonsLaunch public immutable pons;
    IPonsEscrow public immutable escrow;
    bytes32 public immutable ponsCodeHash;
    bytes32 public immutable escrowCodeHash;
    mapping(address => IPonsCurve) public curveOf;
    event ProjectLaunched(address indexed owner, address indexed token, address indexed vault, address curve, bytes32 salt);

    constructor(address admin_, address authorizer_, address treasury_, IPonsLaunch pons_)
        GameplayVaultFactory(admin_, authorizer_, treasury_)
    {
        if (block.chainid != 46630 || address(pons_).code.length == 0) revert Invalid();
        pons = pons_;
        escrow = IPonsEscrow(pons_.feeEscrow());
        if (address(escrow).code.length == 0) revert Invalid();
        ponsCodeHash = address(pons_).codehash;
        escrowCodeHash = address(escrow).codehash;
    }
    function _deployImplementation() internal override returns (address) {
        return address(new PonsGameplayVault(IGameplayFactory(address(this))));
    }
    function checkPons() public view {
        if (address(pons).codehash != ponsCodeHash || address(escrow).codehash != escrowCodeHash
            || pons.feeEscrow() != address(escrow)) revert Invalid();
    }
    function launchSalt(address owner, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode("pons", owner, salt));
    }
    function predictLaunchVault(address owner, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, launchSalt(owner, salt), address(this));
    }
    function launch(IPonsLaunch.TokenParams calldata draft) external payable nonReentrant
        returns (address token, address curve, address vault)
    {
        checkPons();
        if (paused || !pons.canLaunch(msg.sender) || draft.expectedEconomics == bytes32(0)
            || draft.buybackEnabled) revert Invalid();
        bytes32 salt = launchSalt(msg.sender, draft.salt);
        vault = Clones.cloneDeterministic(implementation, salt);
        IPonsLaunch.TokenParams memory params = draft;
        params.creatorFeeRecipient = vault;
        params.salt = salt;
        address[] memory exemptions = new address[](1);
        exemptions[0] = msg.sender;
        (token, curve) = pons.launchToken{value: msg.value}(params, 0, address(0), exemptions);
        if (curve.code.length == 0) revert Invalid();
        curveOf[token] = IPonsCurve(curve);
        // No plugin executes before registration and its unchanged 48-hour activation delay.
        _registerVault(msg.sender, token, vault, address(0), new GameplayPolicy[](0));
        emit ProjectLaunched(msg.sender, token, vault, curve, draft.salt);
    }
}
