# NixOS configuration for a TmuxDeck Cloud Relay server.
#
# USAGE
# -----
# 1. Add cloud-relay flake as an input in your server's flake.nix:
#
#      inputs.tmuxdeck-relay.url = "github:andreabadesso/tmuxdeck?dir=cloud-relay";
#
# 2. Import this file and the relay NixOS module:
#
#      nixosConfigurations.relay = nixpkgs.lib.nixosSystem {
#        system = "x86_64-linux";
#        modules = [
#          inputs.tmuxdeck-relay.nixosModules.default
#          ./nix/relay-server.nix
#          ./hardware-configuration.nix
#        ];
#      };
#
# 3. Provide secrets (generate with `mix phx.gen.secret`):
#
#      echo "SECRET_KEY_BASE=$(mix phx.gen.secret)" > /run/keys/relay-secrets
#
# 4. Deploy:
#
#      nixos-rebuild switch --target-host root@<your-server-ip> --flake .#relay
#
# WILDCARD SSL
# ------------
# Wildcard certs (*.relay.example.com) require DNS-01 challenge.
# The config below uses Caddy with Cloudflare DNS. Set CLOUDFLARE_API_TOKEN
# in /run/keys/cloudflare-token or switch to another ACME DNS provider.
# If you don't need wildcard subdomains (e.g. single-tenant), remove the
# wildcard virtualHost and use a regular cert instead.

{ config, pkgs, lib, ... }:

{
  # ── Basic system ──────────────────────────────────────────────────────────

  system.stateVersion = "24.11";

  boot.loader.grub.enable = true;
  boot.loader.grub.device = "/dev/vda"; # adjust for your disk

  networking = {
    hostName = "relay";
    firewall.allowedTCPPorts = [ 22 80 443 ];
  };

  time.timeZone = "UTC";

  # ── SSH access ────────────────────────────────────────────────────────────

  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      PermitRootLogin = "prohibit-password";
    };
  };

  users.users.deploy = {
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    # Add your public key here:
    openssh.authorizedKeys.keys = [
      # "ssh-ed25519 AAAA... you@host"
    ];
  };

  security.sudo.wheelNeedsPassword = false;

  # ── TmuxDeck Relay service ────────────────────────────────────────────────

  services.tmuxdeck-relay = {
    enable = true;

    # The domain where your relay is hosted.
    # Instances get subdomains: <id>.relay.example.com
    domain = "relay.example.com";

    port = 4000;

    database = {
      name = "tmuxdeck_relay";
      user = "relay";
    };

    # File must contain: SECRET_KEY_BASE=<64-char hex string>
    # Generate with: mix phx.gen.secret
    secretKeyBaseFile = "/run/keys/relay-secrets";
  };

  # ── Caddy with wildcard TLS (Cloudflare DNS) ──────────────────────────────

  # Override the Caddy package to include the Cloudflare DNS plugin.
  services.caddy.package = pkgs.caddy.withPlugins {
    plugins = [ "github.com/caddy-dns/cloudflare@v0.0.0-20240703190432-89f16b99c18e" ];
    hash = lib.fakeSha256; # Replace with real hash on first build
  };

  # Cloudflare API token for DNS-01 challenge (for wildcard cert).
  # Store as: echo "CLOUDFLARE_API_TOKEN=<token>" > /run/keys/cloudflare-token
  systemd.services.caddy.serviceConfig.EnvironmentFile =
    lib.mkForce "/run/keys/cloudflare-token";

  # ── PostgreSQL backup ─────────────────────────────────────────────────────

  services.postgresqlBackup = {
    enable = true;
    databases = [ "tmuxdeck_relay" ];
    startAt = "daily";
  };

  # ── Automatic updates ─────────────────────────────────────────────────────

  system.autoUpgrade = {
    enable = false; # Enable once you're confident in the setup
    flake = "github:andreabadesso/tmuxdeck?dir=cloud-relay";
    flags = [ "--update-input" "nixpkgs" ];
  };
}
