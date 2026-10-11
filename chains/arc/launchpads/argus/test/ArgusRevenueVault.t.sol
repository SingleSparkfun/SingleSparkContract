// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ArgusRevenueVault, IArgusVaultPortal} from "../ArgusRevenueVault.sol";
import {ArgusVaultFactory} from "../ArgusVaultFactory.sol";
import {ArgusCustodyRouter} from "../ArgusCustodyRouter.sol";
import {ArgusTestQuote} from "./ArgusGovernance.t.sol";

contract VaultTestToken is ERC20 {
    constructor() ERC20("Vault token", "VLT") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}
contract VaultTestLegacyImplementation {
    function layoutVersion() external pure returns (uint256) { return 1; }
}
// Reproduce the pre-weighted storage state so legacy execution and upgrades remain covered.
contract VaultTestFixedAllocation is ArgusRevenueVault {
    function initialize(address owner, uint8 selected) public override {
        super.initialize(owner, selected);
        weightedAllocation = false;
        weights = [uint16(8000), 400, 200, 350, 1000];
    }
}
contract VaultTestSplitter {
    address public creator;
    constructor(address creator_) { creator = creator_; }
    function distribute() external pure returns (uint256, uint256) { return (0, 0); }
    function claim(address account) external view returns (uint256, uint256, uint256) {
        require(account == creator); return (0, 0, 0);
    }
    function collect() external pure returns (uint256, uint256) { return (0, 0); }
}
contract VaultTestPortal is IArgusVaultPortal {
    mapping(address => address) public creator;
    mapping(address => address) public splitter;
    function launch(Params calldata, Meta calldata, bytes32, bytes32) external returns (address token) {
        token = address(new VaultTestToken());
        creator[token] = msg.sender;
        splitter[token] = address(new VaultTestSplitter(msg.sender));
    }
    function launches(address token) external view returns (address, int24, bool, address, address, address, uint16, uint16, uint256, int24, address) {
        return (creator[token], 0, true, splitter[token], address(2), splitter[token], 100, 100, 1, 200,
            0x3600000000000000000000000000000000000000);
    }
}
contract VaultTestRouter {
    VaultTestPortal public portal = new VaultTestPortal();
    address public platformToken = address(new VaultTestToken());
    address public operations = address(0x7000);
    bool public governanceEnabled;
    mapping(address => address) public community;
    mapping(address => uint256) public totalPaid;
    ArgusTestQuote public constant quote = ArgusTestQuote(0x3600000000000000000000000000000000000000);
    function poolKey(address target) external view returns (PoolKey memory key) {
        require(target.code.length > 0 && target != address(quote));
        key.currency0 = Currency.wrap(address(quote)); key.currency1 = Currency.wrap(target);
    }
    function register(address token, address) external returns (address) {
        require(portal.creator(token) == msg.sender); community[token] = msg.sender; return msg.sender;
    }
    function trade(address token, bool, uint256 amount, uint256 minimum, uint256) external returns (uint256 output) {
        quote.transferFrom(msg.sender, address(this), amount / 1e12);
        output = amount * 10; require(output >= minimum);
        VaultTestToken(token).mint(msg.sender, output);
    }
    function buyAndBurn(address token, uint256 amount, uint256 minimum, uint256) external returns (uint256 output) {
        quote.transferFrom(msg.sender, address(this), amount);
        output = amount * 1e13; require(output >= minimum);
        VaultTestToken(token).mint(address(0xdead), output);
    }
    function distribute(address token, uint256 expected, address[] calldata recipients) external {
        require(totalPaid[token] == expected);
        address previous;
        for (uint256 i; i < recipients.length; ++i) {
            require(recipients[i] > previous); previous = recipients[i];
            ERC20(token).transferFrom(msg.sender, recipients[i], 10e18);
        }
        totalPaid[token] += recipients.length;
    }
    function fundTreasury(address, bool platform, uint256 amount) external {
        require(platform); quote.transferFrom(msg.sender, operations, amount);
    }
}

contract ArgusRevenueVaultTest is Test {
    address constant ADMIN = address(0xa001);
    uint256 constant EXECUTOR_KEY = 1;
    address constant EXECUTOR = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf;
    address constant OWNER = address(0x1001);
    ArgusTestQuote quote;
    VaultTestRouter router;
    ArgusVaultFactory factory;
    ArgusRevenueVault vault;
    address token;
    address platform;
    function setUp() public {
        vm.chainId(5042); vm.warp(1_800_000_000);
        ArgusTestQuote q = new ArgusTestQuote();
        vm.etch(0x3600000000000000000000000000000000000000, address(q).code);
        quote = ArgusTestQuote(0x3600000000000000000000000000000000000000);
        router = new VaultTestRouter();
        platform = router.platformToken();
        factory = new ArgusVaultFactory(ArgusCustodyRouter(address(router)), ADMIN, EXECUTOR, address(new VaultTestFixedAllocation()));
        (vault, token) = launch(OWNER, bytes32(uint256(1)), 7);
    }
    function launch(address owner, bytes32 salt, uint8 plugins) internal returns (ArgusRevenueVault v, address t) {
        IArgusVaultPortal.Params memory p;
        p.name = "Test"; p.symbol = "TEST"; p.totalSupply = 1_000_000_000e18;
        p.startFdvUsdc6 = 2500e6; p.bondFdvUsdc6 = 45000e6; p.buyTaxBps = 200; p.sellTaxBps = 200;
        p.creatorBps = 10000; p.quoteAsset = address(quote); p.expectConvert = 1;
        IArgusVaultPortal.Meta memory meta;
        vm.prank(owner); t = factory.launch(p, meta, salt, bytes32(0), plugins, "ipfs://test");
        v = ArgusRevenueVault(payable(factory.vaultOf(t)));
        assertEq(address(v), factory.predictVault(owner, salt));
    }
    function fund(uint256 amount) internal { quote.mint(address(vault), amount); vault.sync(); }
    function buy(uint8 bucket, uint256 amount) internal {
        uint256 n = vault.nonce(); uint256 deadline = vm.getBlockTimestamp() + 30;
        address target = factory.platformToken();
        vm.prank(EXECUTOR);
        if (bucket == 1) vault.buyPlatform(target, amount, 1, deadline, n);
        else vault.buy(bucket, amount, 1, deadline, n);
    }
    function allocation() internal pure returns (uint16[5] memory) { return [uint16(8300), 700, 500, 400, 100]; }
    function testCreatorAndFeesBelongToContractWithoutAProjectKey() public view {
        assertGt(address(vault).code.length, 0);
        assertEq(router.portal().creator(token), address(vault));
        assertEq(VaultTestSplitter(vault.splitter()).creator(), address(vault));
        assertEq(vault.initiator(), OWNER);
    }
    function testProjectsShareImplementationButNeverBalances() public {
        (ArgusRevenueVault other,) = launch(address(0x1002), bytes32(uint256(1)), 7);
        fund(100e6); assertEq(other.accounted(), 0);
        assertEq(vault.budgets(0), 80e6); assertEq(vault.budgets(1), 4e6);
        assertEq(vault.budgets(2), 2e6); assertEq(vault.budgets(3), 3500000); assertEq(vault.budgets(4), 10e6); assertEq(vault.claimBudget(), 500000);
        assertEq(address(vault.controller()), address(other.controller()));
    }
    function testFuzzAllocationConservesEveryBaseUnit(uint96 amount) public {
        fund(amount); uint256 sum;
        for (uint256 i; i < 5; ++i) sum += vault.budgets(i);
        assertEq(sum + vault.claimBudget(), amount); vault.sync(); assertEq(vault.received(), amount);
    }
    function testOnlyExecutorMayBuyAndEveryDebitStaysInItsBucket() public {
        fund(100e6);
        vm.expectRevert(); vault.buy(0, 1e6, 1, block.timestamp + 30, 0);
        vm.prank(EXECUTOR); vm.expectRevert(); vault.buyPlatform(platform, 8e6, 1, block.timestamp + 30, 0);
        buy(1, 4e6); assertEq(vault.budgets(0), 80e6); assertEq(vault.budgets(1), 0);
        assertEq(quote.allowance(address(vault), address(router)), 0);
        vm.prank(EXECUTOR); vm.expectRevert(); vault.buy(0, 1e6, 1, block.timestamp + 30, 0);
    }
    function testAllEightSelectionsExecuteOnlyTheirOwnBuckets() public {
        for (uint8 selection; selection < 8; ++selection) {
            (ArgusRevenueVault v,) = launch(OWNER, bytes32(uint256(100 + selection)), selection);
            quote.mint(address(v), 100e6); v.sync();
            for (uint8 bucket; bucket < 3; ++bucket) {
                uint8 bit = bucket == 0 ? 1 : bucket == 1 ? 4 : 2;
                uint256 n = v.nonce();
                if (selection & bit == 0) {
                    vm.prank(EXECUTOR); vm.expectRevert();
                    if (bucket == 1) v.buyPlatform(platform, 1e6, 1, block.timestamp + 30, n);
                    else v.buy(bucket, 1e6, 1, block.timestamp + 30, n);
                    assertEq(v.nonce(), n);
                } else {
                    vm.prank(EXECUTOR);
                    if (bucket == 1) v.buyPlatform(platform, 1e6, 1, block.timestamp + 30, n);
                    else v.buy(bucket, 1e6, 1, block.timestamp + 30, n);
                    assertEq(v.nonce(), n + 1);
                }
                uint256 original = bucket == 0 ? 80e6 : bucket == 1 ? 4e6 : 2e6;
                assertEq(v.budgets(bucket), original - (selection & bit == 0 ? 0 : 1e6));
            }
        }
    }
    function testPlatformPauseIsIndependentAndResumeWaits48Hours() public {
        fund(100e6);
        vm.prank(EXECUTOR); factory.pause(address(0), 4);
        buy(0, 1e6); buy(2, 1e6);
        uint256 n = vault.nonce();
        vm.prank(EXECUTOR); vm.expectRevert(); vault.buyPlatform(platform, 1e6, 1, block.timestamp + 30, n);
        assertEq(vault.budgets(1), 4e6);
        vm.prank(ADMIN); factory.scheduleResume(4);
        vm.expectRevert(); factory.executeResume(4);
        vm.warp(factory.readyAt()); factory.executeResume(4);
        buy(1, 1e6); assertEq(vault.budgets(1), 3e6);
    }
    function testOneDelayedTargetUpdateAppliesToEveryVaultWithoutMovingFunds() public {
        (ArgusRevenueVault other, address otherToken) = launch(address(0x1002), bytes32(uint256(21)), 7);
        fund(100e6); quote.mint(address(other), 100e6); other.sync();
        address previous = factory.platformToken();
        address next = address(new VaultTestToken());
        vm.prank(EXECUTOR); vm.expectRevert(); factory.schedulePlatformToken(next);
        vm.prank(ADMIN); factory.schedulePlatformToken(next);
        vm.expectRevert(); factory.executePlatformToken(next);
        vm.warp(factory.readyAt()); factory.executePlatformToken(next);
        assertEq(factory.platformToken(), next);
        assertEq(vault.token(), token); assertEq(other.token(), otherToken);
        assertEq(vault.budgets(1), 4e6); assertEq(other.budgets(1), 4e6);
        uint256 deadline = vm.getBlockTimestamp() + 30;
        vm.prank(EXECUTOR); vm.expectRevert(); vault.buyPlatform(previous, 1e6, 1, deadline, 0);
        vm.prank(EXECUTOR); vm.expectRevert(); vault.buy(1, 1e6, 1, deadline, 0);
        vm.prank(EXECUTOR); vault.buyPlatform(next, 1e6, 1, deadline, 0);
        vm.prank(EXECUTOR); other.buyPlatform(next, 1e6, 1, deadline, 0);
        assertEq(ERC20(next).balanceOf(address(0xdead)), 20e18);
        assertEq(ERC20(previous).balanceOf(address(0xdead)), 0);
        assertEq(vault.budgets(0), 80e6); assertEq(other.budgets(0), 80e6);
        assertEq(vault.budgets(1), 3e6); assertEq(other.budgets(1), 3e6);
    }
    function testTargetChangeChecksCodeAndInvalidatesOnEmergencyPause() public {
        vm.prank(ADMIN); vm.expectRevert(); factory.schedulePlatformToken(address(quote));
        vm.prank(ADMIN); vm.expectRevert(); factory.schedulePlatformToken(address(0x1111));
        address next = address(new VaultTestToken());
        vm.prank(ADMIN); factory.schedulePlatformToken(next);
        vm.warp(factory.readyAt());
        vm.prank(EXECUTOR); factory.pause(address(0), 4);
        vm.expectRevert(); factory.executePlatformToken(next);
        vm.prank(ADMIN); factory.cancel();
        vm.prank(ADMIN); factory.schedulePlatformToken(next);
        vm.warp(factory.readyAt()); vm.etch(next, hex"00");
        vm.expectRevert(); factory.executePlatformToken(next);
        assertEq(factory.platformToken(), router.platformToken());
    }
    function testNewFactoryRejectsLegacyImplementationAndUnknownMasks() public {
        address legacy = address(new VaultTestLegacyImplementation());
        vm.expectRevert(); new ArgusVaultFactory(ArgusCustodyRouter(address(router)), ADMIN, EXECUTOR, legacy);
        vm.prank(ADMIN); vm.expectRevert(); factory.scheduleUpgrade(legacy);
        vm.prank(ADMIN); vm.expectRevert(); factory.schedulePolicy(address(vault), 8, allocation());
        vm.prank(EXECUTOR); vm.expectRevert(); factory.pause(address(vault), 8);
        vm.prank(ADMIN); vm.expectRevert(); factory.scheduleResume(8);
        vm.expectRevert(); this.invalidLaunch();
    }
    function invalidLaunch() external { launch(OWNER, bytes32(uint256(99)), 8); }
    function testMinimumOutputFailureRollsBackBudgetAndNonce() public {
        fund(100e6);
        vm.prank(EXECUTOR); vm.expectRevert(); vault.buy(0, 1e6, type(uint256).max, block.timestamp + 30, 0);
        assertEq(vault.nonce(), 0); assertEq(vault.budgets(0), 80e6); assertEq(vault.accounted(), 100e6);
    }
    function testPayoutCannotReplayOrUseUnbudgetedTokens() public {
        fund(5000e6); buy(2, 100e6);
        address[] memory recipients = new address[](100);
        for (uint256 i; i < 100; ++i) recipients[i] = address(uint160(0x9000 + i));
        uint256 n = vault.nonce(); vm.prank(EXECUTOR); vault.distribute(n, recipients);
        assertEq(vault.totalPaid(), 100); assertEq(vault.rewardTokens(), 0);
        VaultTestToken(token).mint(address(vault), 1000e18);
        n = vault.nonce(); vm.prank(EXECUTOR); vm.expectRevert(); vault.distribute(n, recipients);
        assertEq(vault.totalPaid(), 100);
    }
    function testGlobalPauseIncludesFutureVaultsAndCollectionRemainsAvailable() public {
        fund(100e6); vm.prank(EXECUTOR); factory.pause(address(0), 1);
        vm.prank(EXECUTOR); vm.expectRevert(); vault.buy(0, 1e6, 1, block.timestamp + 30, 0);
        (ArgusRevenueVault other,) = launch(address(0x1002), bytes32(uint256(2)), 7);
        (, uint8 stopped,) = other.policy(); assertEq(stopped, 1);
        vault.collect(); buy(2, 2e6);
    }
    function testResumeWaits48HoursAndCannotOverrideANewerPause() public {
        vm.prank(EXECUTOR); factory.pause(address(0), 3);
        vm.prank(ADMIN); factory.scheduleResume(3);
        vm.expectRevert(); factory.executeResume(3);
        vm.warp(factory.readyAt());
        vm.prank(EXECUTOR); factory.pause(address(0), 1);
        vm.expectRevert(); factory.executeResume(3);
        vm.prank(ADMIN); factory.cancel();
        vm.prank(ADMIN); factory.scheduleResume(3);
        vm.warp(factory.readyAt()); factory.executeResume(3);
        assertEq(factory.globalPaused(), 0);
    }
    function testPolicyBooksOldIncomeAndKeepsExistingBudgets() public {
        quote.mint(address(vault), 100e6);
        uint16[5] memory next = [uint16(10000), 0, 0, 0, 0];
        vm.prank(ADMIN); factory.schedulePolicy(address(vault), 1, next);
        vm.warp(factory.readyAt()); factory.executePolicy(address(vault), 1, next);
        assertEq(vault.budgets(0), 80e6); assertEq(vault.budgets(3), 3500000);
        fund(100e6); assertEq(vault.budgets(0), 180e6); assertEq(vault.budgets(3), 3500000);
    }
    function testLocalResumeCannotClearGlobalPause() public {
        vm.prank(EXECUTOR); factory.pause(address(vault), 3);
        vm.prank(EXECUTOR); factory.pause(address(0), 1);
        vm.prank(ADMIN); factory.schedulePolicy(address(vault), 3, allocation());
        vm.warp(factory.readyAt()); factory.executePolicy(address(vault), 3, allocation());
        (,uint8 stopped,) = vault.policy(); assertEq(stopped, 1);
    }
    function testUpgradeIsDelayedCodeBoundAndPreservesState() public {
        fund(100e6); address next = address(new ArgusRevenueVault());
        vm.prank(EXECUTOR); vm.expectRevert(); factory.scheduleUpgrade(next);
        vm.prank(ADMIN); factory.scheduleUpgrade(next);
        vm.expectRevert(); factory.executeUpgrade(next);
        vm.warp(factory.readyAt());
        factory.executeUpgrade(next);
        assertEq(factory.implementation(), next); assertEq(vault.budgets(0), 80e6);
        assertEq(vault.token(), token); assertEq(vault.initiator(), OWNER);
    }
    function testUpgradeRejectsChangedCodeAfterScheduling() public {
        address next = address(new ArgusRevenueVault());
        vm.prank(ADMIN); factory.scheduleUpgrade(next);
        vm.warp(factory.readyAt()); vm.etch(next, hex"00");
        vm.expectRevert(); factory.executeUpgrade(next);
    }
    function testTreasuryHasFixedDestinationAndNoVotingReserveCannotBeWithdrawn() public {
        fund(100e6); vault.settle(true, 1e6);
        assertEq(quote.balanceOf(router.operations()), 1e6);
        vm.expectRevert(); vault.settle(false, 3500000);
        assertEq(vault.budgets(3), 3500000);
    }
    function testInitializeAndControllerCallsCannotBeHijacked() public {
        vm.expectRevert(); vault.initialize(address(this), 3);
        vm.expectRevert(); vault.setPolicy(3, allocation());
        vm.expectRevert(); vault.pause(1);
        vm.expectRevert(); factory.pause(address(vault), 1);
        ArgusRevenueVault impl = ArgusRevenueVault(payable(factory.implementation()));
        vm.expectRevert(); impl.initialize(address(this), 3);
    }
}
