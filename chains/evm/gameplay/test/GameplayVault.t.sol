// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GameplayFixture, GameplayTestToken, GameplayNoReturnToken, GameplayForwardingRecipient} from "./GameplayFixture.sol";
import {GameplayVault} from "../GameplayVault.sol";
import {GameplayClaim, GameplayPolicy} from "../IGameplayProtocol.sol";

contract GameplayVaultTest is GameplayFixture {
    function testFactoryRegistersExistingTokenAndKeepsProjectsSeparate() public {
        project.mint(OWNER, 123 ether);
        address predicted = factory.predictVault(OWNER, address(project));
        GameplayVault vault = create(address(quote), policies(address(quote)));
        assertEq(address(vault), predicted);
        assertEq(factory.vaultOf(OWNER, address(project)), address(vault));
        assertEq(project.balanceOf(OWNER), 123 ether);
        vm.expectRevert(); vm.prank(OWNER);
        factory.createVault(address(project), address(0), policies(address(0)));
        vm.prank(CALLER);
        GameplayVault other = GameplayVault(payable(factory.createVault(address(project), address(quote), policies(address(quote)))));
        fund(vault, 100e6);
        assertEq(other.accounted(), 0);
        assertEq(other.budget(BURN), 0);
        assertEq(vault.owner(), OWNER);
        assertEq(other.owner(), CALLER);
    }
    function testInitializationCannotBeStolenOrRepeated() public {
        GameplayVault vault = create(address(quote), policies(address(quote)));
        vm.expectRevert(); vault.initialize(CALLER, address(project), address(0), policies(address(0)));
        vm.expectRevert(); vm.prank(address(factory));
        vault.initialize(CALLER, address(project), address(0), policies(address(0)));
        GameplayVault implementation = GameplayVault(payable(factory.implementation()));
        vm.expectRevert(); vm.prank(address(factory));
        implementation.initialize(CALLER, address(project), address(0), policies(address(0)));
    }
    function testNativeDepositAndClaimNeedNoWrappedToken() public {
        GameplayVault vault = create(address(0), policies(address(0)));
        fund(vault, 100 ether);
        assertEq(vault.platformBudget(), 10 ether);
        assertEq(vault.claimBudget(), 0.5 ether);
        assertEq(vault.budget(BURN), uint256(89.5 ether) / 3);
        uint256 beforeBurn = address(0xdead).balance;
        uint256 beforeCaller = CALLER.balance;
        GameplayClaim memory c = request(vault, BURN, 1 ether, "");
        c.reward = uint256(1 ether) * 50 / 8950;
        execute(vault, c, "");
        assertEq(address(0xdead).balance, beforeBurn + 1 ether);
        assertEq(CALLER.balance, beforeCaller + c.reward);
        assertEq(vault.accounted(), address(vault).balance);
        vault.settlePlatform();
        assertEq(TREASURY.balance, 10 ether);
        assertEq(vault.accounted(), address(vault).balance);
    }
    function testSixDecimalAssetAndDirectTransfersAccountExactlyOnce() public {
        GameplayVault vault = create(address(quote), policies(address(quote)));
        fund(vault, 100e6);
        assertEq(vault.budget(BURN), 29833333);
        assertEq(vault.budget(PLATFORM), 29833333);
        assertEq(vault.budget(DISTRIBUTE), 29833334);
        quote.mint(address(vault), 100e6); vault.sync(); vault.sync();
        assertEq(vault.received(), 200e6);
        vault.settlePlatform();
        assertEq(quote.balanceOf(TREASURY), 20e6);
        assertEq(vault.platformBudget(), 0);
        assertEq(vault.accounted(), quote.balanceOf(address(vault)));
    }
    function testUnexpectedAssetNeverCreatesBudget() public {
        GameplayVault vault = create(address(quote), policies(address(quote)));
        project.mint(address(vault), 100 ether);
        vault.sync(); assertEq(vault.accounted(), 0);
        vm.expectRevert(); vm.prank(CALLER); vault.deposit{value: 1}(1);
        vm.prank(CALLER); (bool ok,) = address(vault).call{value: 1}("");
        assertFalse(ok);
    }
    function testNativeAmountMustMatchAndDirectNativeIncomeSyncs() public {
        GameplayVault vault = create(address(0), policies(address(0)));
        vm.expectRevert(); vm.prank(CALLER); vault.deposit{value: 1}(2);
        vm.prank(CALLER); (bool ok,) = address(vault).call{value: 100 ether}("");
        assertTrue(ok); assertEq(vault.received(), 0);
        vault.sync(); assertEq(vault.received(), 100 ether);
    }
    function testInventoryIsNotNewIncomeAndRewardRequiresActualPayout() public {
        GameplayVault vault = create(address(quote), policies(address(quote)));
        fund(vault, 100e6);
        GameplayClaim memory c = request(vault, DISTRIBUTE, 8950, "");
        c.reward = 1;
        bytes memory sig = sign(vault, c);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, "", sig);
        c.reward = 0; execute(vault, c, "");
        assertEq(vault.inventory(DISTRIBUTE), 8950);
        assertEq(vault.reservedClaim(), 50);
        assertEq(vault.accounted(), 100e6);
        vault.sync(); assertEq(vault.received(), 100e6);
        bytes memory data = abi.encode(recipients());
        c = request(vault, DISTRIBUTE, 0, data);
        execute(vault, c, data);
        assertEq(quote.balanceOf(address(0x4000)), 10);
        assertEq(vault.inventory(DISTRIBUTE), 8930);
        assertEq(vault.accounted(), quote.balanceOf(address(vault)));
        c = request(vault, DISTRIBUTE, 0, data); sig = sign(vault, c);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, data, sig);
    }
    function testDistributionRewardReleasedOnlyOnceOnCompleteDelivery() public {
        GameplayPolicy[] memory p = policies(address(quote));
        p[2].rules = abi.encode(uint256(4475), uint256(2));
        GameplayVault vault = create(address(quote), p); fund(vault, 100e6);
        execute(vault, request(vault, DISTRIBUTE, 8950, ""), "");
        bytes memory data = abi.encode(recipients());
        GameplayClaim memory c = request(vault, DISTRIBUTE, 0, data); c.reward = 51;
        bytes memory sig = sign(vault, c);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, data, sig);
        assertFalse(vault.paid(address(0x4000)));
        c.reward = 50; execute(vault, c, data);
        assertEq(quote.balanceOf(CALLER), 50);
        assertEq(vault.reservedClaim(), 0);
        assertEq(vault.inventory(DISTRIBUTE), 0);
    }
    function testNativeInventoryPaysRecipientsAndCaller() public {
        GameplayPolicy[] memory p = policies(address(0));
        p[2].rules = abi.encode(uint256(4475), uint256(2));
        GameplayVault vault = create(address(0), p); fund(vault, 100000);
        execute(vault, request(vault, DISTRIBUTE, 8950, ""), "");
        bytes memory data = abi.encode(recipients());
        GameplayClaim memory c = request(vault, DISTRIBUTE, 0, data); c.reward = 50;
        execute(vault, c, data);
        assertEq(address(0x4000).balance, 4475);
        assertEq(vault.accounted(), address(vault).balance);
    }
    function testRestrictedStockTokenPayoutIsAtomic() public {
        GameplayVault vault = create(address(quote), policies(address(quote)));
        quote.setRestricted(true); quote.allow(address(vault));
        fund(vault, 100e6);
        execute(vault, request(vault, DISTRIBUTE, 1000, ""), "");
        quote.allow(address(0x4000));
        bytes memory data = abi.encode(recipients());
        GameplayClaim memory c = request(vault, DISTRIBUTE, 0, data);
        bytes memory sig = sign(vault, c);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, data, sig);
        assertEq(vault.inventory(DISTRIBUTE), 1000);
        assertEq(quote.balanceOf(address(0x4000)), 0);
        assertFalse(vault.paid(address(0x4000)));
        quote.allow(address(0x4001)); execute(vault, c, data);
        assertEq(quote.balanceOf(address(0x4001)), 10);
    }
    function testTaxedDepositsRejectBeforeLockingFundsAndPayoutsStayExact() public {
        GameplayVault vault = create(address(quote), policies(address(quote)));
        quote.setTaxed(true); quote.mint(CALLER, 100e6);
        vm.prank(CALLER); quote.approve(address(vault), 100e6);
        vm.expectRevert(); vm.prank(CALLER); vault.deposit(100e6);
        assertEq(quote.balanceOf(CALLER), 100e6); assertEq(vault.received(), 0);
        quote.setTaxed(false);
        vm.prank(CALLER); vault.deposit(100e6);
        quote.setTaxed(true);
        GameplayClaim memory c = request(vault, BURN, 1000, "");
        bytes memory sig = sign(vault, c);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, "", sig);
        assertEq(vault.accounted(), 100e6);
        assertEq(quote.balanceOf(address(0xdead)), 0);
    }
    function testFuzzDepositsPreserveEveryBaseUnit(uint96 amount) public {
        vm.assume(amount != 0);
        GameplayVault vault = create(address(quote), policies(address(quote))); fund(vault, amount);
        assertEq(vault.budget(BURN) + vault.budget(PLATFORM) + vault.budget(DISTRIBUTE)
            + vault.platformBudget() + vault.claimBudget() + vault.unallocated(), amount);
        vault.sync(); assertEq(vault.received(), amount);
    }
    function testNonReturningErc20DoesNotRequireMetadataOrBoolReturns() public {
        GameplayNoReturnToken asset = new GameplayNoReturnToken();
        GameplayVault vault = create(address(asset), policies(address(asset)));
        asset.mint(CALLER, 100e6);
        vm.startPrank(CALLER); asset.approve(address(vault), 100e6); vault.deposit(100e6); vm.stopPrank();
        execute(vault, request(vault, BURN, 1000, ""), "");
        vault.settlePlatform();
        assertEq(asset.balanceOf(address(0xdead)), 1000);
        assertEq(asset.balanceOf(TREASURY), 10e6);
        assertEq(vault.accounted(), asset.balanceOf(address(vault)));
    }
    function testNativeContractRecipientCanForwardButCannotReenter() public {
        GameplayVault vault = create(address(0), policies(address(0))); fund(vault, 100000);
        execute(vault, request(vault, DISTRIBUTE, 1000, ""), "");
        GameplayForwardingRecipient recipient = new GameplayForwardingRecipient(); recipient.bind(vault);
        address[] memory list = new address[](2);
        list[0] = address(0x4000); list[1] = address(recipient);
        bytes memory data = abi.encode(list);
        execute(vault, request(vault, DISTRIBUTE, 0, data), data);
        assertFalse(recipient.reentered()); assertEq(address(0x5000).balance, 10);
        assertEq(vault.accounted(), address(vault).balance);
    }
}
