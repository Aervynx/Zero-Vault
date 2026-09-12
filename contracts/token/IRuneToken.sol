// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IRuneToken is IERC20 {
    event AccountBlacklisted(address indexed account);
    event AccountUnblacklisted(address indexed account);

    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
    function blacklistAccount(address account) external;
    function unblacklistAccount(address account) external;
    function pause() external;
    function unpause() external;
    function isBlacklisted(address account) external view returns (bool);
}