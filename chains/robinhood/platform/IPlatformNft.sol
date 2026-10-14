// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

interface IPlatformNft is IERC721 {
    /// Immutable quality: legacy collections use 1..4; random collections use their own 1..8 grades.
    function qualityOf(uint256 tokenId) external view returns (uint8);
}

interface IPlatformNftController {
    function paused() external view returns (bool);
}
