flake:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.tmuxdeck;
  inherit (pkgs.stdenv.hostPlatform) isDarwin isLinux;
in
{
  options.services.tmuxdeck = {
    enable = lib.mkEnableOption "TmuxDeck service";

    package = lib.mkOption {
      type = lib.types.package;
      default = flake.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "The TmuxDeck package to use.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8000;
      description = "Port to listen on.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Host/address to bind to.";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.home.homeDirectory}/.local/share/tmuxdeck";
      description = "Directory for TmuxDeck persistent data.";
    };

    dockerSocket = lib.mkOption {
      type = lib.types.str;
      default = "/var/run/docker.sock";
      description = "Path to the Docker socket.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Path to an environment file with secrets (e.g. Telegram tokens).";
    };
  };

  config = lib.mkIf cfg.enable {
    # Ensure data directory exists
    home.activation.tmuxdeckDataDir = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      mkdir -p "${cfg.dataDir}"
    '';

    # Linux: systemd user service
    systemd.user.services.tmuxdeck = lib.mkIf isLinux {
      Unit = {
        Description = "TmuxDeck — Docker + tmux session manager";
        After = [ "network.target" ];
      };
      Service = {
        Type = "simple";
        ExecStart = "${cfg.package}/bin/tmuxdeck";
        Restart = "on-failure";
        RestartSec = 5;
        Environment = [
          "HOST=${cfg.host}"
          "PORT=${toString cfg.port}"
          "DATA_DIR=${cfg.dataDir}"
          "DOCKER_SOCKET=${cfg.dockerSocket}"
        ];
      } // lib.optionalAttrs (cfg.environmentFile != null) {
        EnvironmentFile = cfg.environmentFile;
      };
      Install.WantedBy = [ "default.target" ];
    };

    # macOS: launchd agent
    launchd.agents.tmuxdeck = lib.mkIf isDarwin {
      enable = true;
      config = {
        Label = "com.tmuxdeck.server";
        ProgramArguments = [ "${cfg.package}/bin/tmuxdeck" ];
        EnvironmentVariables = {
          HOST = cfg.host;
          PORT = toString cfg.port;
          DATA_DIR = cfg.dataDir;
          DOCKER_SOCKET = cfg.dockerSocket;
        };
        RunAtLoad = true;
        KeepAlive = true;
        StandardOutPath = "${cfg.dataDir}/tmuxdeck.log";
        StandardErrorPath = "${cfg.dataDir}/tmuxdeck.err.log";
      };
    };
  };
}
