// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {HookFixture} from "./HookFixture.sol";
import {HookVault} from "../HookVault.sol";
import {HookClaim, HookPolicy} from "../IHookProtocol.sol";

/// Mixed operation sequences must conserve each project's funds, including unsynced income and inventory.
contract HookAccountingInvariantTest is HookFixture {
    HookVault[3] private vaults;
    uint256[3] private income;
    uint256[3] private outgoing;
    uint256[3] private recipientBatch;
    HookClaim[3] private lastClaim;
    bytes[3] private lastData;
    bytes[3] private lastSignature;

    function setUp() public override {
        super.setUp();
        vaults[0] = create(address(quote), policies(address(quote)));
        vm.prank(CALLER);
        vaults[1] = HookVault(payable(factory.createVault(address(project), address(quote), policies(address(quote)))));
        vm.prank(address(0x5000));
        vaults[2] = HookVault(payable(factory.createVault(address(project), address(0), policies(address(0)))));
        for (uint256 i; i < vaults.length; ++i) fundProject(i, 100_000);
        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = this.fundProject.selector;
        selectors[1] = this.directIncome.selector;
        selectors[2] = this.syncProject.selector;
        selectors[3] = this.executeWork.selector;
        selectors[4] = this.payRecipients.selector;
        selectors[5] = this.changeWeights.selector;
        selectors[6] = this.togglePause.selector;
        selectors[7] = this.settleTreasury.selector;
        selectors[8] = this.rejectReplay.selector;
        targetSelector(FuzzSelector(address(this), selectors));
        targetContract(address(this));
    }

    function balance(HookVault v) private view returns (uint256) {
        return v.asset() == address(0) ? address(v).balance : quote.balanceOf(address(v));
    }
    function fundProject(uint256 projectSeed, uint256 amountSeed) public {
        uint256 i = projectSeed % vaults.length;
        uint256 amount = bound(amountSeed, 1, 1e12);
        fund(vaults[i], amount); income[i] += amount;
    }
    function directIncome(uint256 projectSeed, uint256 amountSeed) public {
        uint256 i = projectSeed % vaults.length;
        uint256 amount = bound(amountSeed, 1, 1e12);
        HookVault v = vaults[i];
        if (v.asset() == address(0)) {
            vm.prank(CALLER); (bool ok,) = address(v).call{value: amount}(""); assertTrue(ok);
        } else quote.mint(address(v), amount);
        income[i] += amount;
    }
    function syncProject(uint256 projectSeed) public { vaults[projectSeed % vaults.length].sync(); }
    function enabled(HookVault v, bytes32 id) private view returns (bool) {
        return !factory.paused() && !v.paused() && !v.pluginPaused(id) && v.policy(id).weight != 0;
    }
    function executeWork(uint256 projectSeed, uint256 pluginSeed, uint256 amountSeed) public {
        uint256 i = projectSeed % vaults.length;
        HookVault v = vaults[i];
        bytes32 id = pluginSeed % 3 == 0 ? BURN : pluginSeed % 3 == 1 ? PLATFORM : DISTRIBUTE;
        v.sync();
        if (!enabled(v, id) || v.budget(id) == 0) return;
        uint256 amount = bound(amountSeed, 1, v.budget(id));
        HookClaim memory c = request(v, id, amount, "");
        if (id != DISTRIBUTE) {
            uint256 earned = amount * 50 / 8950;
            uint256 available = v.claimBudget() - v.reservedClaim();
            c.reward = earned < available ? earned : available;
        }
        uint256 beforeBalance = balance(v);
        uint256 beforeInventory = v.inventory(id);
        bytes memory sig = sign(v, c);
        vm.prank(CALLER); v.claim(c, "", sig);
        uint256 spent = id == DISTRIBUTE ? 0 : amount + c.reward;
        assertEq(balance(v), beforeBalance - spent);
        assertEq(v.inventory(id), beforeInventory + (id == DISTRIBUTE ? amount : 0));
        outgoing[i] += spent;
        lastClaim[i] = c; lastData[i] = ""; lastSignature[i] = sig;
    }
    function payRecipients(uint256 projectSeed) public {
        uint256 i = projectSeed % vaults.length;
        HookVault v = vaults[i]; v.sync();
        uint256 inventory = v.inventory(DISTRIBUTE);
        if (!enabled(v, DISTRIBUTE) || inventory < 20) return;
        address[] memory to = new address[](2);
        uint256 first = 0x100000 + i * 1_000_000 + ++recipientBatch[i] * 2;
        to[0] = address(uint160(first)); to[1] = address(uint160(first + 1));
        bytes memory data = abi.encode(to);
        HookClaim memory c = request(v, DISTRIBUTE, 0, data);
        c.reward = v.inventoryReward(DISTRIBUTE) * 20 / inventory;
        uint256 beforeBalance = balance(v);
        bytes memory sig = sign(v, c);
        vm.prank(CALLER); v.claim(c, data, sig);
        assertEq(balance(v), beforeBalance - 20 - c.reward);
        assertEq(v.inventory(DISTRIBUTE), inventory - 20);
        assertTrue(v.paid(to[0]) && v.paid(to[1]));
        outgoing[i] += 20 + c.reward;
        lastClaim[i] = c; lastData[i] = data; lastSignature[i] = sig;
    }
    function changeWeights(uint256 projectSeed, uint256 maskSeed, uint256 weightSeed) public {
        HookVault v = vaults[projectSeed % vaults.length];
        HookPolicy[] memory p = policies(v.asset());
        for (uint256 j; j < p.length; ++j) p[j].weight = maskSeed & (1 << j) == 0 ? 0 : uint32(1 + (weightSeed >> (j * 8)) % 10);
        changePolicy(v, p);
    }
    function togglePause(uint256 projectSeed, bool global) public {
        if (global) {
            if (!factory.paused()) factory.pause();
            else {
                bytes32 operation = factory.scheduleGlobalResume();
                vm.expectRevert(); factory.executeGlobalResume();
                vm.warp(factory.readyAt(operation)); factory.executeGlobalResume();
            }
        } else {
            HookVault v = vaults[projectSeed % vaults.length];
            if (!v.paused()) factory.pauseVault(address(v), bytes32(0));
            else {
                bytes32 operation = factory.scheduleResume(address(v), bytes32(0));
                vm.expectRevert(); factory.executeResume(address(v), bytes32(0));
                vm.warp(factory.readyAt(operation)); factory.executeResume(address(v), bytes32(0));
            }
        }
    }
    function settleTreasury(uint256 projectSeed) public {
        uint256 i = projectSeed % vaults.length;
        HookVault v = vaults[i]; v.sync();
        uint256 amount = v.platformBudget();
        uint256 beforeBalance = balance(v);
        v.settlePlatform(); assertEq(balance(v), beforeBalance - amount); outgoing[i] += amount;
    }
    function rejectReplay(uint256 projectSeed) public {
        uint256 i = projectSeed % vaults.length;
        if (lastSignature[i].length == 0) return;
        HookVault v = vaults[i];
        uint256 beforeBalance = balance(v);
        uint256 nonce = v.nonce();
        vm.expectRevert(); vm.prank(CALLER); v.claim(lastClaim[i], lastData[i], lastSignature[i]);
        assertEq(balance(v), beforeBalance); assertEq(v.nonce(), nonce);
    }

    function testMixedLifecycleRetainsInventoryAcrossPauseAndPolicyChanges() public {
        executeWork(0, 2, 8950);
        assertEq(vaults[0].inventory(DISTRIBUTE), 8950);
        togglePause(0, true);
        changeWeights(0, 3, 0);
        directIncome(0, 200);
        directIncome(1, 300);
        settleTreasury(0);
        togglePause(0, true);
        changeWeights(0, 7, 0);
        payRecipients(0);
        assertEq(vaults[0].inventory(DISTRIBUTE), 8930);
        rejectReplay(0);
        directIncome(2, 400);
        executeWork(2, 0, 8950);
        settleTreasury(2);
        invariantEveryProjectConservesItsOwnFundsAndRewardReserve();
    }

    function invariantEveryProjectConservesItsOwnFundsAndRewardReserve() public view {
        for (uint256 i; i < vaults.length; ++i) {
            HookVault v = vaults[i];
            uint256 ledger = v.platformBudget() + v.claimBudget() + v.unallocated() + v.roundingReserve();
            bytes32[3] memory ids = [BURN, PLATFORM, DISTRIBUTE];
            uint256 reserved;
            for (uint256 j; j < ids.length; ++j) {
                ledger += v.budget(ids[j]) + v.inventory(ids[j]);
                reserved += v.inventoryReward(ids[j]);
            }
            assertEq(ledger, v.accounted());
            assertGe(balance(v), v.accounted());
            assertEq(balance(v) + outgoing[i], income[i]);
            assertEq(v.received() + balance(v) - v.accounted(), income[i]);
            assertEq(v.reservedClaim(), reserved);
            assertLe(reserved, v.claimBudget());
        }
    }
}
