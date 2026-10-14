// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PonsVaultFactory} from "../PonsVaultFactory.sol";
import {PonsGameplayVault} from "../PonsGameplayVault.sol";
import {IPonsLaunch, IPonsHook} from "../IPonsLaunch.sol";
import {GameplayPolicy} from "../../../../evm/gameplay/IGameplayProtocol.sol";

contract TestPonsEscrow {
    mapping(address => uint256) public balanceOf;
    function credit(address recipient) external payable { balanceOf[recipient] += msg.value; }
    function claim() external returns (uint256 amount) {
        amount = balanceOf[msg.sender]; balanceOf[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}(""); require(ok);
    }
}
contract TestPonsToken is ERC20 { constructor() ERC20("Fixture", "FIX") {} }
contract TestPonsHook {
    address public immutable factory;
    TestPonsEscrow public immutable feeEscrow;
    address public feeSweepOperator = address(0x7777);
    mapping(bytes32 => IPonsHook.LaunchInfo) private records;
    mapping(bytes32 => mapping(address => uint256)) public pendingFees;
    mapping(bytes32 => mapping(address => uint256)) public pendingCreatorTax;
    mapping(bytes32 => mapping(address => uint256)) public pendingBuyback;
    constructor(TestPonsEscrow escrow_) { factory = msg.sender; feeEscrow = escrow_; }
    function register(bytes32 poolId, address token, address creator) external {
        require(msg.sender == factory);
        records[poolId] = IPonsHook.LaunchInfo(true, false, token, address(0), creator, creator, address(0x9999), 0, 0, 0, 0, 100, false);
    }
    function launches(bytes32 poolId) external view returns (IPonsHook.LaunchInfo memory) { return records[poolId]; }
    function accrue(bytes32 poolId, uint256 tax) external payable {
        require(tax <= msg.value); pendingFees[poolId][address(0)] += msg.value - tax;
        pendingCreatorTax[poolId][address(0)] += tax;
    }
    function setTokenFees(bytes32 poolId, address token, uint256 amount) external { pendingFees[poolId][token] = amount; }
    function setTokenTax(bytes32 poolId, address token, uint256 amount) external { pendingCreatorTax[poolId][token] = amount; }
    function setBuyback(bytes32 poolId, uint256 amount) external { pendingBuyback[poolId][address(0)] = amount; }
    function sweepPoolFees(bytes32 poolId, uint256 minimumConversion, uint256 minimumBuyback) external {
        IPonsHook.LaunchInfo memory info = records[poolId];
        require(info.registered && (msg.sender == info.creator || msg.sender == feeSweepOperator));
        // Mirror the pinned upstream: only its operator may convert memecoin fees.
        require(msg.sender == feeSweepOperator || (pendingFees[poolId][info.memecoin] == 0
            && pendingCreatorTax[poolId][info.memecoin] == 0 && pendingBuyback[poolId][address(0)] == 0));
        require(pendingFees[poolId][info.memecoin] == 0 || minimumConversion != 0);
        require(pendingBuyback[poolId][address(0)] == 0 || minimumBuyback != 0);
        uint256 amount = pendingFees[poolId][address(0)] + pendingCreatorTax[poolId][address(0)];
        pendingFees[poolId][address(0)] = 0; pendingCreatorTax[poolId][address(0)] = 0;
        pendingFees[poolId][info.memecoin] = 0;
        if (amount != 0) feeEscrow.credit{value: amount}(info.creator);
    }
}
contract TestPonsCurve {
    bool public graduated;
    address public immutable recipient;
    TestPonsEscrow public immutable escrow;
    constructor(address recipient_, TestPonsEscrow escrow_) { recipient = recipient_; escrow = escrow_; }
    function sweepFees(uint256) external {
        require(msg.sender == recipient && !graduated);
        escrow.credit{value: address(this).balance}(recipient);
    }
    function graduate() external { graduated = true; }
    receive() external payable {}
}
contract TestPonsLaunch {
    TestPonsEscrow public immutable feeEscrow = new TestPonsEscrow();
    TestPonsHook public immutable memeHook = new TestPonsHook(feeEscrow);
    mapping(address => IPonsLaunch.LaunchedToken) private launched;
    bool public allowed = true;
    uint256 public fee;
    bytes32 public constant ECONOMICS = keccak256("economics");
    address public lastExemption;
    address public lastRecipient;
    function canLaunch(address) external view returns (bool) { return allowed; }
    function setAllowed(bool value) external { allowed = value; }
    function setFee(uint256 value) external { fee = value; }
    function launchToken(IPonsLaunch.TokenParams calldata p, uint256 config, address pair, address[] calldata exemptions)
        external payable returns (address token, address curve)
    {
        require(allowed && msg.value == fee && p.expectedEconomics == ECONOMICS && config == 0 && pair == address(0));
        require(!p.buybackEnabled);
        lastExemption = exemptions[0]; lastRecipient = p.creatorFeeRecipient;
        token = address(new TestPonsToken());
        curve = address(new TestPonsCurve(p.creatorFeeRecipient, feeEscrow));
        IPonsLaunch.LaunchedToken storage item = launched[token];
        item.token = token; item.curve = curve; item.creatorFeeRecipient = p.creatorFeeRecipient;
        item.tickSpacing = 200; item.exists = true;
    }
    function getLaunchedToken(address token) external view returns (IPonsLaunch.LaunchedToken memory) { return launched[token]; }
    function graduate(address token) external returns (bytes32 poolId) {
        IPonsLaunch.LaunchedToken storage item = launched[token];
        TestPonsCurve(payable(item.curve)).graduate(); item.phase = 2;
        poolId = keccak256(abi.encode(address(0), token, uint24(0), int24(200), address(memeHook)));
        memeHook.register(poolId, token, item.creatorFeeRecipient);
    }
}
contract PonsVaultFactoryTest is Test {
    TestPonsLaunch source;
    PonsVaultFactory factory;
    address constant OWNER = address(0x1234);
    address constant OTHER = address(0x5678);
    address constant TREASURY = address(0x9999);
    function setUp() public {
        vm.chainId(46630);
        source = new TestPonsLaunch();
        factory = new PonsVaultFactory(address(this), OTHER, TREASURY, IPonsLaunch(address(source)));
    }
    function draft() internal view returns (IPonsLaunch.TokenParams memory p) {
        p.name = "Test Project"; p.symbol = "TEST"; p.creatorTaxBps = 200;
        p.expectedEconomics = source.ECONOMICS(); p.salt = keccak256("project");
        p.creatorFeeRecipient = OTHER;
    }
    function launch() internal returns (address token, address curve, PonsGameplayVault vault) {
        IPonsLaunch.TokenParams memory p = draft();
        vm.prank(OWNER);
        address v; (token, curve, v) = factory.launch(p);
        vault = PonsGameplayVault(payable(v));
    }
    function testAtomicLaunchBindsOwnerAndIgnoresExternalRecipient() public {
        address predicted = factory.predictLaunchVault(OWNER, draft().salt);
        (address token, address curve, PonsGameplayVault vault) = launch();
        assertEq(address(vault), predicted); assertEq(vault.owner(), OWNER);
        assertEq(vault.projectToken(), token); assertEq(vault.asset(), address(0));
        assertEq(address(factory.curveOf(token)), curve);
        assertEq(factory.vaultOf(OWNER, token), predicted); assertTrue(factory.isVault(predicted));
        assertEq(source.lastRecipient(), predicted); assertEq(source.lastExemption(), OWNER);
        assertEq(factory.DELAY(), 48 hours);
        vm.expectRevert(); vault.initialize(OTHER, token, address(0), new GameplayPolicy[](0));
    }
    function testRevenueCollectionIsPermissionlessAndBudgetedExactlyOnce() public {
        (,address curve, PonsGameplayVault vault) = launch();
        vm.deal(curve, 100 ether);
        vm.prank(OTHER); vault.collectRevenue();
        assertEq(address(vault).balance, 100 ether); assertEq(vault.received(), 100 ether);
        assertEq(vault.platformBudget(), 10 ether); assertEq(vault.claimBudget(), 0.5 ether);
        assertEq(vault.unallocated(), 89.5 ether);
        vault.collectRevenue(); assertEq(vault.received(), 100 ether);
        assertEq(OTHER.balance, 0); assertEq(OWNER.balance, 0);
        vault.settlePlatform(); assertEq(TREASURY.balance, 10 ether);
    }
    function testGraduatedRevenueAndDirectDepositsStillReachSameBudget() public {
        (,address curve, PonsGameplayVault vault) = launch();
        TestPonsCurve(payable(curve)).graduate();
        vm.deal(address(this), 2 ether);
        source.feeEscrow().credit{value: 1 ether}(address(vault));
        vault.collectRevenue();
        vault.deposit{value: 1 ether}(1 ether);
        assertEq(vault.received(), 2 ether); assertEq(vault.unallocated(), 1.79 ether);
    }
    function testGraduatedNativeHookFeesAndTaxReachVaultExactlyOnce() public {
        (address token,, PonsGameplayVault vault) = launch();
        bytes32 poolId = source.graduate(token);
        vm.deal(address(this), 10 ether);
        source.memeHook().accrue{value: 10 ether}(poolId, 3 ether);
        vm.prank(OTHER); vault.collectRevenue();
        assertEq(vault.received(), 10 ether); assertEq(address(vault).balance, 10 ether);
        assertEq(vault.platformBudget(), 1 ether); assertEq(vault.claimBudget(), 0.05 ether);
        assertEq(vault.unallocated(), 8.95 ether); assertEq(OTHER.balance, 0); assertEq(OWNER.balance, 0);
        vault.collectRevenue(); assertEq(vault.received(), 10 ether);
        assertEq(source.memeHook().pendingFees(poolId, address(0)), 0);
        assertEq(source.memeHook().pendingCreatorTax(poolId, address(0)), 0);
    }
    function testTokenFeeConversionRequiresUpstreamOperatorWithoutInventingVaultIncome() public {
        (address token,, PonsGameplayVault vault) = launch();
        bytes32 poolId = source.graduate(token);
        vm.deal(address(this), 3 ether);
        source.memeHook().accrue{value: 2 ether}(poolId, 0);
        source.memeHook().setTokenFees(poolId, token, 100);
        (,uint256 nativePending,uint256 tokenPending,bool needsOperator) = vault.poolRevenue();
        assertEq(nativePending, 2 ether); assertEq(tokenPending, 100); assertTrue(needsOperator);
        vm.expectRevert(abi.encodeWithSelector(PonsGameplayVault.UpstreamFeeSweepRequired.selector, poolId, address(0x7777)));
        vault.collectRevenue();
        assertEq(vault.received(), 0); assertEq(vault.accounted(), 0);
        // Previously collected escrow remains claimable while the upstream operator is needed.
        source.feeEscrow().credit{value: 1 ether}(address(vault));
        vault.collectRevenue(); assertEq(vault.received(), 1 ether);
        assertEq(source.memeHook().pendingFees(poolId, address(0)), 2 ether);
        TestPonsHook hook = source.memeHook();
        vm.expectRevert(); hook.sweepPoolFees(poolId, 0, 0);
        vm.prank(address(0x7777)); hook.sweepPoolFees(poolId, 1, 0);
        vault.collectRevenue(); assertEq(vault.received(), 3 ether);
        vault.collectRevenue(); assertEq(vault.received(), 3 ether);
    }
    function testTokenTaxAndBuybackEachRequireOperator() public {
        (address token,, PonsGameplayVault vault) = launch();
        bytes32 poolId = source.graduate(token);
        source.memeHook().setTokenTax(poolId, token, 1);
        (,,,bool needsOperator) = vault.poolRevenue(); assertTrue(needsOperator);
        source.memeHook().setTokenTax(poolId, token, 0);
        source.memeHook().setBuyback(poolId, 1);
        (,,,needsOperator) = vault.poolRevenue(); assertTrue(needsOperator);
        vm.expectRevert(abi.encodeWithSelector(PonsGameplayVault.UpstreamFeeSweepRequired.selector, poolId, address(0x7777))); vault.collectRevenue();
    }
    function testChangedHookCodeBlocksCollectionBeforeFundsMove() public {
        (address token,, PonsGameplayVault vault) = launch(); source.graduate(token);
        vm.etch(address(source.memeHook()), hex"00");
        vm.expectRevert(); vault.collectRevenue();
        vm.expectRevert(); vault.poolRevenue();
        assertEq(vault.received(), 0);
    }
    function testSameSaltCannotDuplicateProjectAndOtherOwnerCannotStealIt() public {
        IPonsLaunch.TokenParams memory p = draft();
        address expected = factory.predictLaunchVault(OWNER, p.salt);
        vm.prank(OTHER); (,,address otherVault) = factory.launch(p);
        assertTrue(otherVault != expected);
        (,,PonsGameplayVault vault) = launch(); assertEq(address(vault), expected);
        vm.expectRevert(); vm.prank(OWNER); factory.launch(p);
    }
    function testRevertedLaunchRollsBackVaultAndCanBeRetried() public {
        IPonsLaunch.TokenParams memory p = draft(); p.expectedEconomics = bytes32(uint256(1));
        address predicted = factory.predictLaunchVault(OWNER, p.salt);
        vm.expectRevert(); vm.prank(OWNER); factory.launch(p);
        assertEq(predicted.code.length, 0);
        (,,PonsGameplayVault vault) = launch(); assertEq(address(vault), predicted);
    }
    function testRefusesUncommittedEconomicsBuybackPauseAndChangedCode() public {
        IPonsLaunch.TokenParams memory p = draft(); p.expectedEconomics = bytes32(0);
        vm.expectRevert(); factory.launch(p);
        p = draft(); p.buybackEnabled = true; vm.expectRevert(); factory.launch(p);
        p = draft(); source.setAllowed(false); vm.expectRevert(); factory.launch(p);
        source.setAllowed(true); factory.pause(); vm.expectRevert(); factory.launch(p);
        vm.etch(address(source), hex"00"); vm.expectRevert(); factory.checkPons();
    }
    function testLaunchFeeCannotSilentlyIncrease() public {
        source.setFee(1 ether);
        IPonsLaunch.TokenParams memory p = draft();
        vm.expectRevert(); vm.prank(OWNER); factory.launch(p);
        vm.deal(OWNER, 1 ether); vm.prank(OWNER); factory.launch{value: 1 ether}(p);
        assertEq(address(factory).balance, 0);
    }
    function testMainnetDeploymentIsNotAuthorized() public {
        vm.chainId(4663); vm.expectRevert();
        new PonsVaultFactory(address(this), OTHER, TREASURY, IPonsLaunch(address(source)));
    }
}
