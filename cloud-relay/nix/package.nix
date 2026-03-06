{ lib
, beamPackages
, pkgs
, git
, cacert
}:

let
  src = ../.;
  version = "0.1.0";
  erlang = beamPackages.erlang;
  elixir = beamPackages.elixir;
  hex = beamPackages.hex;
  rebar3 = beamPackages.rebar3;

  mixFodDeps = beamPackages.fetchMixDeps {
    pname = "relay-mix-deps";
    inherit src version;
    sha256 = "sha256-0/5TPeSRbTViMKtxRRUswu0Wt4huD+WiYR9dV+2oNhU=";
  };
in

pkgs.stdenv.mkDerivation {
  pname = "tmuxdeck-relay";
  inherit src version;

  nativeBuildInputs = [ elixir hex git cacert pkgs.nodejs pkgs.tailwindcss pkgs.esbuild ];
  buildInputs = [ erlang rebar3 ];

  MIX_ENV = "prod";
  MIX_REBAR3 = "${rebar3}/bin/rebar3";
  HEX_OFFLINE = "1";
  LANG = "C.UTF-8";
  LC_ALL = "C.UTF-8";
  ELIXIR_ERL_OPTIONS = "+fnu";
  ESBUILD_PATH = "${pkgs.esbuild}/bin/esbuild";
  TAILWIND_PATH = "${pkgs.tailwindcss}/bin/tailwindcss";
  SSL_CERT_FILE = "${cacert}/etc/ssl/certs/ca-bundle.crt";
  HEX_CACERTS_PATH = "${cacert}/etc/ssl/certs/ca-bundle.crt";

  configurePhase = ''
    runHook preConfigure
    export HOME=$(mktemp -d)

    # hex setupHook sets HEX_HOME; set MIX_HOME alongside it
    export MIX_HOME="$HOME/.mix"
    export HEX_HOME="$MIX_HOME/hex"
    mkdir -p "$MIX_HOME" "$HEX_HOME"

    # Copy hex archive into MIX_HOME so mix can find it
    mkdir -p "$MIX_HOME/archives"
    cp -r ${hex}/lib/erlang/lib/hex* "$MIX_HOME/archives/" 2>/dev/null || true

    # Link fetched deps
    cp -r ${mixFodDeps} deps
    chmod -R u+w deps

    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild

    # Remove heroicons from mix.lock to avoid lock mismatch
    # (it's app: false, compile: false — only used for SVG icons at build time)
    sed -i '/heroicons/d' mix.lock

    mix deps.compile --force
    mix compile

    # Build assets
    mix assets.deploy 2>/dev/null || true

    # Build release
    mix release --overwrite

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r _build/prod/rel/relay/* $out/
    runHook postInstall
  '';

  meta = with lib; {
    description = "TmuxDeck Cloud Relay - tunnel proxy for remote TmuxDeck access";
    license = licenses.mit;
    platforms = platforms.linux;
    mainProgram = "relay";
  };
}
