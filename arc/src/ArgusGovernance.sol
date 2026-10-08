// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ArcProjectTreasury, IProjectTreasuryFactory} from "./ArcProjectTreasury.sol";
import {ArcSatisfaction} from "./ArcSatisfaction.sol";

interface IArgusBuybackFunding { function fundPlatformBuybackUsdc6(uint256 amount) external; }

/// The existing governance rules and public amount ABI stay native18; settlements use USDC6.
contract ArgusProjectTreasury is ArcProjectTreasury {
    using SafeERC20 for IERC20;
    IERC20 public constant quoteAsset = IERC20(0x3600000000000000000000000000000000000000);
    constructor(IProjectTreasuryFactory factory_, address initiator, address team_)
        ArcProjectTreasury(factory_, initiator, team_) {}
    function _balance() internal view override returns (uint256) { return quoteAsset.balanceOf(address(this)) * 1e12; }
    function _validAmount(uint256 amount) internal pure override returns (bool) { return amount % 1e12 == 0; }
    function _pay(address to, uint256 amount) internal override { quoteAsset.safeTransfer(to, amount / 1e12); }
}

contract ArgusSatisfaction is ArcSatisfaction {
    using SafeERC20 for IERC20;
    IERC20 public constant quoteAsset = IERC20(0x3600000000000000000000000000000000000000);
    constructor(address team_, uint256 roundDuration_, uint256 votingDuration_, uint256 quorum_)
        ArcSatisfaction(team_, roundDuration_, votingDuration_, quorum_) {}
    function _balance() internal view override returns (uint256) { return quoteAsset.balanceOf(address(this)) * 1e12; }
    function payoutOf(uint256 round, address voter) public view override returns (uint256) {
        return super.payoutOf(round, voter) / 1e12 * 1e12;
    }
    function _teamShare(uint256 pot) internal pure override returns (uint256) { return (pot / 1e12 * TEAM_BPS / 10_000) * 1e12; }
    function _pay(address to, uint256 amount) internal override { quoteAsset.safeTransfer(to, amount / 1e12); }
    function _fundBuyback(uint256 amount) internal override {
        quoteAsset.forceApprove(address(factory), amount / 1e12);
        IArgusBuybackFunding(address(factory)).fundPlatformBuybackUsdc6(amount / 1e12);
        quoteAsset.forceApprove(address(factory), 0);
    }
}
