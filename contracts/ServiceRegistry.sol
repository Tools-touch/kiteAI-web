// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Versioned service metadata and availability. Holds no assets.
contract ServiceRegistry {
    struct Service {
        string name;
        string path;
        uint64 version;
        bool enabled;
    }

    address public immutable owner;
    mapping(bytes32 => Service) public services;

    error Unauthorized();
    error InvalidService();

    event ServiceConfigured(bytes32 indexed id, uint64 version, bool enabled, string name, string path);

    constructor() {
        owner = msg.sender;
    }

    /// @notice Register or replace a service configuration. Disable with enabled=false.
    function configure(bytes32 id, string calldata name, string calldata path, bool enabled) external {
        if (msg.sender != owner) revert Unauthorized();
        bytes memory route = bytes(path);
        if (id == bytes32(0) || bytes(name).length == 0 || bytes(name).length > 96 ||
            route.length < 2 || route.length > 128 || route[0] != 0x2f || route[1] == 0x2f) {
            revert InvalidService();
        }
        uint64 version = services[id].version + 1;
        services[id] = Service(name, path, version, enabled);
        emit ServiceConfigured(id, version, enabled, name, path);
    }
}
