# RouterOS Cloud Agent

This is the no-extra-hardware connection path. A supported MikroTik runs a small RouterOS scheduler script that makes outbound HTTPS requests to WiFi Voucher. Because the connection is initiated from the customer network, it can operate behind NAT/CGNAT without port forwarding.

The cloud agent is allowlisted to voucher operations only: test, create_users, delete_users, and usage. It does not accept arbitrary RouterOS commands from the cloud.

RouterOS 7 is the initial supported agent target because its scripting environment provides JSON serialize/deserialize. Older RouterOS installations can continue using direct API or the existing LAN connector fallback until a compatible agent protocol is added.
