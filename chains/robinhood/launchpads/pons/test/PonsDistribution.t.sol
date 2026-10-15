// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PonsVaultFactoryTest} from "./PonsVaultFactory.t.sol";
import {PonsHookVault} from "../PonsHookVault.sol";
import {PonsVaultFactory} from "../PonsVaultFactory.sol";
import {IPonsLaunch} from "../IPonsLaunch.sol";
import {DistributionHook} from "../../../../evm/hooks/RevenueHooks.sol";
import {HookClaim, HookPolicy} from "../../../../evm/hooks/IHookProtocol.sol";

contract PonsDistributionTest is PonsVaultFactoryTest {
    uint256 constant KEY = 0x123456;
    bytes32 constant DISTRIBUTE = keccak256("distribution@1");
    function testDigestMatchesBackendAndWalletEip712Vector() public {
        vm.etch(address(0x1009), factory.implementation().code);
        HookClaim memory c = HookClaim(address(1),DISTRIBUTE,0,0,9,1000,7,3,4,keccak256(""));
        assertEq(PonsHookVault(payable(address(0x1009))).claimDigest(c), 0x16fd5fa328621425921e3e8945702cb910200f5786aaa364f440baf8f967eb6b);
    }

    function testRepeatedRecipientsReceiveEveryShareButCannotReplayAuthorization() public {
        // This fixture pays native ETH directly to isolate payout policy from the exchange adapter.
        factory = new PonsVaultFactory(address(this), vm.addr(KEY), TREASURY, IPonsLaunch(address(source)));
        (,,PonsHookVault vault) = launch();
        DistributionHook plugin = new DistributionHook();
        factory.schedulePlugin(DISTRIBUTE, address(plugin));
        vm.warp(block.timestamp + 48 hours);
        factory.executePlugin(DISTRIBUTE, address(plugin));
        HookPolicy[] memory policies = new HookPolicy[](1);
        policies[0] = HookPolicy(DISTRIBUTE, 1, address(0), address(0), 10000, "", abi.encode(uint256(10), uint256(2)));
        bytes32 operation = factory.schedulePolicy(address(vault), policies);
        vm.warp(factory.readyAt(operation)); factory.executePolicy(address(vault), policies);
        vm.deal(address(this), 100000); vault.deposit{value:100000}(100000);
        address[] memory recipients = new address[](2);
        recipients[0] = address(0x4000); recipients[1] = address(0x4001);
        bytes memory data = abi.encode(recipients);
        HookClaim memory inventory = request(vault, 1000, "");
        execute(vault, inventory, "");
        HookClaim memory first = request(vault, 0, data);
        bytes memory signature = sign(vault, first);
        vm.prank(OTHER); vault.claim(first, data, signature);
        assertFalse(vault.permanentPayoutDeduplication()); assertFalse(vault.paid(recipients[0]));
        vm.expectRevert(); vm.prank(OTHER); vault.claim(first, data, signature);
        execute(vault, request(vault, 0, data), data);
        assertEq(recipients[0].balance, 20); assertEq(recipients[1].balance, 20);
        recipients[1] = recipients[0]; data = abi.encode(recipients);
        execute(vault, request(vault, 0, data), data);
        assertEq(address(0x4000).balance, 40); assertEq(address(0x4001).balance, 20);
        recipients[0] = address(0); data = abi.encode(recipients);
        HookClaim memory invalid = request(vault, 0, data);
        signature = sign(vault, invalid);
        uint256 nonce = vault.nonce(); uint256 balance = address(0x4000).balance; uint256 remaining = vault.inventory(DISTRIBUTE);
        vm.expectRevert(); vm.prank(OTHER); vault.claim(invalid, data, signature);
        assertEq(vault.nonce(), nonce); assertEq(address(0x4000).balance, balance); assertEq(vault.inventory(DISTRIBUTE), remaining);
        recipients[0] = address(0x4001); data = abi.encode(recipients);
        invalid = request(vault, 0, data); signature = sign(vault, invalid);
        vm.expectRevert(); vm.prank(OTHER); vault.claim(invalid, data, signature);
        assertEq(vault.nonce(), nonce); assertEq(address(0x4000).balance, balance); assertEq(vault.inventory(DISTRIBUTE), remaining);
    }
    function request(PonsHookVault vault, uint256 amount, bytes memory data) internal view returns (HookClaim memory) {
        return HookClaim(OTHER, DISTRIBUTE, amount, amount == 0 ? 0 : 1, 0, block.timestamp + 120,
            vault.nonce(), vault.revision(), factory.revision(), keccak256(data));
    }
    function sign(PonsHookVault vault, HookClaim memory claim) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, vault.claimDigest(claim));
        return abi.encodePacked(r, s, v);
    }
    function execute(PonsHookVault vault, HookClaim memory claim, bytes memory data) internal {
        bytes memory signature = sign(vault, claim);
        vm.prank(OTHER); vault.claim(claim, data, signature);
    }
}
