// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {HookVault} from "../HookVault.sol";
import {HookVaultFactory} from "../HookVaultFactory.sol";
import {BuybackHook, DistributionHook} from "../RevenueHooks.sol";
import {HookClaim, HookPolicy} from "../IHookProtocol.sol";

contract HookTestToken is ERC20 {
    uint8 private immutable precision;
    bool public taxed;
    bool public restricted;
    mapping(address => bool) public allowed;
    constructor(uint8 decimals_) ERC20("Test asset", "TEST") { precision = decimals_; }
    function decimals() public view override returns (uint8) { return precision; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setTaxed(bool value) external { taxed = value; }
    function setRestricted(bool value) external { restricted = value; }
    function allow(address to) external { allowed[to] = true; }
    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0)) {
            require(!restricted || allowed[to], "Restricted recipient");
            if (taxed) {
                uint256 fee = amount / 100;
                super._update(from, address(0), fee);
                amount -= fee;
            }
        }
        super._update(from, to, amount);
    }
}

// USDT-style non-returning methods; metadata is deliberately absent.
contract HookNoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external { allowance[msg.sender][spender] = amount; }
    function transfer(address to, uint256 amount) external { balanceOf[msg.sender] -= amount; balanceOf[to] += amount; }
    function transferFrom(address from, address to, uint256 amount) external {
        allowance[from][msg.sender] -= amount; balanceOf[from] -= amount; balanceOf[to] += amount;
    }
}

contract HookForwardingRecipient {
    HookVault public vault;
    bool public reentered;
    function bind(HookVault vault_) external { vault = vault_; }
    receive() external payable {
        (reentered,) = address(vault).call(abi.encodeCall(vault.sync, ()));
        (bool ok,) = address(0x5000).call{value: msg.value}("");
        require(ok);
    }
}

abstract contract HookFixture is Test {
    uint256 internal constant SIGNER_KEY = 0x123456;
    address internal constant OWNER = address(0x1000);
    address internal constant CALLER = address(0x2000);
    address internal constant TREASURY = address(0x3000);
    bytes32 internal constant BURN = keccak256("buyback-burn@1");
    bytes32 internal constant PLATFORM = keccak256("platform-buyback@1");
    bytes32 internal constant DISTRIBUTE = keccak256("distribution@1");
    HookVaultFactory internal factory;
    HookTestToken internal project;
    HookTestToken internal quote;
    BuybackHook internal burnPlugin;
    DistributionHook internal distributionPlugin;

    function setUp() public virtual {
        factory = new HookVaultFactory(address(this), vm.addr(SIGNER_KEY), TREASURY);
        project = new HookTestToken(18);
        quote = new HookTestToken(6);
        burnPlugin = new BuybackHook();
        distributionPlugin = new DistributionHook();
        factory.schedulePlugin(BURN, address(burnPlugin));
        factory.schedulePlugin(PLATFORM, address(burnPlugin));
        factory.schedulePlugin(DISTRIBUTE, address(distributionPlugin));
        vm.warp(block.timestamp + 48 hours);
        factory.executePlugin(BURN, address(burnPlugin));
        factory.executePlugin(PLATFORM, address(burnPlugin));
        factory.executePlugin(DISTRIBUTE, address(distributionPlugin));
        vm.deal(CALLER, 1000 ether);
    }
    function policies(address target) internal pure returns (HookPolicy[] memory p) {
        p = new HookPolicy[](3);
        p[0] = HookPolicy(BURN, 1, target, address(0), type(uint128).max, "", "");
        p[1] = HookPolicy(PLATFORM, 1, target, address(0), type(uint128).max, "", "");
        p[2] = HookPolicy(DISTRIBUTE, 1, target, address(0), type(uint128).max, "", abi.encode(uint256(10), uint256(2)));
    }
    function create(address asset, HookPolicy[] memory p) internal returns (HookVault vault) {
        vm.prank(OWNER);
        vault = HookVault(payable(factory.createVault(address(project), asset, p)));
    }
    function fund(HookVault vault, uint256 amount) internal {
        if (vault.asset() == address(0)) {
            vm.prank(CALLER); vault.deposit{value: amount}(amount);
        } else {
            HookTestToken(vault.asset()).mint(CALLER, amount);
            vm.startPrank(CALLER);
            HookTestToken(vault.asset()).approve(address(vault), amount);
            vault.deposit(amount);
            vm.stopPrank();
        }
    }
    function request(HookVault vault, bytes32 id, uint256 amount, bytes memory data)
        internal view returns (HookClaim memory)
    {
        return HookClaim(CALLER, id, amount, amount == 0 ? 0 : 1, 0, block.timestamp + 300,
            vault.nonce(), vault.revision(), factory.revision(), keccak256(data));
    }
    function sign(HookVault vault, HookClaim memory c) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, vault.claimDigest(c));
        return abi.encodePacked(r, s, v);
    }
    function execute(HookVault vault, HookClaim memory c, bytes memory data) internal {
        bytes memory sig = sign(vault, c);
        vm.prank(CALLER); vault.claim(c, data, sig);
    }
    function changePolicy(HookVault vault, HookPolicy[] memory p) internal {
        bytes32 operation = factory.schedulePolicy(address(vault), p);
        vm.warp(factory.readyAt(operation));
        factory.executePolicy(address(vault), p);
    }
    function recipients() internal pure returns (address[] memory result) {
        result = new address[](2);
        result[0] = address(0x4000); result[1] = address(0x4001);
    }
    receive() external payable {}
}
