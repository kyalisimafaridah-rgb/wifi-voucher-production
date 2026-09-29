# WiFi Voucher Remote Connector

This connector lets a customer's MikroTik stay behind NAT/CGNAT while the owner controls the business from anywhere.

The connector makes an outbound secure WebSocket connection to the WiFi Voucher cloud. The cloud never needs to open a connection into the customer's network.

Requirements:
- Node.js 20+
- An always-on Windows, Linux, macOS, Raspberry Pi, or similar device on the same LAN as the MikroTik
- RouterOS API enabled locally; API-SSL on port 8729 is preferred

Setup:
1. Add/test the MikroTik while you are on its local network.
2. In WiFi Voucher, open the router's Remote Connector setup and generate a token.
3. Copy the connector configuration template to a local .env file and fill in the values.
4. Run npm install and npm start.
5. Leave the connector running on the customer's LAN.

The connector automatically reconnects after Internet outages or Render restarts.

Security:
- The connector token is stored only as a SHA-256 hash by the server.
- Router credentials stay on the local connector.
- The cloud sends only approved router operations.
- Never publish the local .env file or connector token.
