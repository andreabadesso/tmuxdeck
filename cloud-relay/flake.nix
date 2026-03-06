{
  description = "TmuxDeck Cloud Relay";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        beamPackages = pkgs.beam.packagesWith pkgs.beam.interpreters.erlang_27;
        elixir = beamPackages.elixir_1_17;
      in {
        packages.default = pkgs.callPackage ./nix/package.nix {
          inherit pkgs beamPackages;
          inherit (pkgs) git cacert;
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [
            elixir
            beamPackages.hex
            pkgs.postgresql_17
          ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [
            pkgs.inotify-tools
          ] ++ pkgs.lib.optionals pkgs.stdenv.isDarwin [
            pkgs.darwin.apple_sdk.frameworks.CoreFoundation
            pkgs.darwin.apple_sdk.frameworks.CoreServices
          ];

          shellHook = ''
            export MIX_HOME=$PWD/.nix-mix
            export HEX_HOME=$PWD/.nix-hex
            export PATH=$MIX_HOME/bin:$HEX_HOME/bin:$PATH
            export ERL_AFLAGS="-kernel shell_history enabled"
          '';
        };
      }
    ) // {
      nixosModules.default = { config, lib, pkgs, ... }:
        let
          cfg = config.services.tmuxdeck-relay;
          relayPkg = self.packages.${pkgs.system}.default;
        in {
          options.services.tmuxdeck-relay = {
            enable = lib.mkEnableOption "TmuxDeck Cloud Relay";

            domain = lib.mkOption {
              type = lib.types.str;
              example = "relay.tmuxdeck.io";
              description = "Domain for the relay service. Instance subdomains are routed as <id>.domain.";
            };

            port = lib.mkOption {
              type = lib.types.port;
              default = 4000;
              description = "Port for the Phoenix app (only reachable via Caddy reverse proxy).";
            };

            database = {
              name = lib.mkOption {
                type = lib.types.str;
                default = "tmuxdeck_relay";
              };
              user = lib.mkOption {
                type = lib.types.str;
                default = "relay";
              };
            };

            # File must contain: SECRET_KEY_BASE=<64-char hex>
            # Generate: nix run nixpkgs#elixir -- -e 'IO.puts(:crypto.strong_rand_bytes(64) |> Base.encode16(case: :lower))'
            secretKeyBaseFile = lib.mkOption {
              type = lib.types.path;
              description = "Path to env file containing SECRET_KEY_BASE=<value>.";
            };

            # Required for wildcard TLS (*.domain) via DNS-01 ACME challenge.
            # File must contain: CLOUDFLARE_API_TOKEN=<token>
            # If null, Caddy will use HTTP-01 (no wildcard — subdomains won't get TLS).
            cloudflareTokenFile = lib.mkOption {
              type = lib.types.nullOr lib.types.path;
              default = null;
              description = "Path to env file containing CLOUDFLARE_API_TOKEN=<value> for wildcard TLS. Required for subdomain tunnel routing over HTTPS.";
            };
          };

          config = lib.mkIf cfg.enable {
            # ── PostgreSQL ──────────────────────────────────────────────────
            services.postgresql = {
              enable = true;
              package = pkgs.postgresql_17;
              ensureDatabases = [ cfg.database.name ];
              ensureUsers = [{
                name = cfg.database.user;
                ensureDBOwnership = true;
              }];
            };

            # ── Relay systemd service ───────────────────────────────────────
            systemd.services.tmuxdeck-relay = {
              description = "TmuxDeck Cloud Relay";
              after = [ "network.target" "postgresql.service" ];
              wantedBy = [ "multi-user.target" ];

              environment = {
                PHX_HOST = cfg.domain;
                PHX_SERVER = "true";
                PORT = toString cfg.port;
                DATABASE_URL = "ecto:///${cfg.database.name}?socket_dir=/run/postgresql";
                MIX_ENV = "prod";
                RELEASE_NAME = "relay";
                RELEASE_DISTRIBUTION = "none";
              };

              serviceConfig = {
                Type = "exec";
                ExecStartPre = "${relayPkg}/bin/relay eval 'Relay.Release.migrate()'";
                ExecStart = "${relayPkg}/bin/relay start";
                Restart = "on-failure";
                RestartSec = 5;
                DynamicUser = true;
                StateDirectory = "tmuxdeck-relay";
                EnvironmentFile = cfg.secretKeyBaseFile;
                NoNewPrivileges = true;
                ProtectSystem = "strict";
                ProtectHome = true;
                PrivateTmp = true;
              };
            };

            # ── Caddy reverse proxy + TLS ───────────────────────────────────
            services.caddy = {
              enable = true;
              virtualHosts = lib.mkMerge [
                # Base domain — always enabled
                {
                  "${cfg.domain}" = {
                    extraConfig = ''
                      reverse_proxy localhost:${toString cfg.port}
                    '';
                  };
                }
                # Wildcard subdomain — only when cloudflareTokenFile is set
                (lib.mkIf (cfg.cloudflareTokenFile != null) {
                  "*.${cfg.domain}" = {
                    extraConfig = ''
                      tls {
                        dns cloudflare {env.CLOUDFLARE_API_TOKEN}
                      }
                      reverse_proxy localhost:${toString cfg.port}
                    '';
                  };
                })
              ];
            };

            # Inject Cloudflare token into Caddy's environment for DNS-01
            systemd.services.caddy.serviceConfig.EnvironmentFile =
              lib.mkIf (cfg.cloudflareTokenFile != null) cfg.cloudflareTokenFile;

            networking.firewall.allowedTCPPorts = [ 80 443 ];
          };
        };
    };
}
