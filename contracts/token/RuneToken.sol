// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/utils/Nonces.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "./IRuneToken.sol";
import "./RuneErrors.sol";

contract RuneToken is ERC20, ERC20Pausable, ERC20Permit, ERC20Votes, AccessControl, IRuneToken {

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant BLACKLIST_MANAGER_ROLE = keccak256("BLACKLIST_MANAGER_ROLE");

    uint256 public constant MAX_SUPPLY = 1_000_000_000 * 10**18;

    mapping(address => bool) private _blacklist;

    constructor(address initialAdmin) 
        ERC20("Rune", "RUNE") 
        ERC20Permit("Rune") 
        AccessControl() 
    {
        if (initialAdmin == address(0)) revert RuneErrors.Rune__ZeroAddressProvided();

        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(MINTER_ROLE, initialAdmin);
        _grantRole(PAUSER_ROLE, initialAdmin);
        _grantRole(BLACKLIST_MANAGER_ROLE, initialAdmin);
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Pausable, ERC20Votes) {
        if (_blacklist[from]) revert RuneErrors.Rune__BlacklistedAccount(from);
        if (_blacklist[to]) revert RuneErrors.Rune__BlacklistedAccount(to);

        super._update(from, to, value);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (totalSupply() + amount > MAX_SUPPLY) {
            revert RuneErrors.Rune__MaxSupplyExceeded(amount, MAX_SUPPLY - totalSupply());
        }
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(_msgSender(), amount);
    }

    function blacklistAccount(address account) external onlyRole(BLACKLIST_MANAGER_ROLE) {
        if (account == address(0)) revert RuneErrors.Rune__ZeroAddressProvided();
        if (_blacklist[account]) return;

        _blacklist[account] = true;
        emit AccountBlacklisted(account);
    }

    function unblacklistAccount(address account) external onlyRole(BLACKLIST_MANAGER_ROLE) {
        if (account == address(0)) revert RuneErrors.Rune__ZeroAddressProvided();
        if (!_blacklist[account]) return;

        _blacklist[account] = false;
        emit AccountUnblacklisted(account);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function isBlacklisted(address account) external view returns (bool) {
        return _blacklist[account];
    }
}