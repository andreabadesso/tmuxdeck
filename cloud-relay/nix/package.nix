{ lib, stdenv, elixir, beamPackages, git, rebar3 ? beamPackages.rebar3, hex ? beamPackages.hex }:

let
  mixFodDeps = beamPackages.fetchMixDeps {
    pname = "relay-deps";
    version = "0.1.0";
    src = ../.;
    sha256 = lib.fakeSha256;
    # This hash needs to be updated after first build attempt.
    # Run: nix build 2>&1 | grep 'got:' and use that hash.
  };
in
stdenv.mkDerivation rec {
  pname = "tmuxdeck-relay";
  version = "0.1.0";
  src = ../.;

  nativeBuildInputs = [ elixir hex git ];
  buildInputs = [ rebar3 ];

  MIX_ENV = "prod";
  MIX_REBAR3 = "${rebar3}/bin/rebar3";
  HEX_OFFLINE = "1";
  LANG = "en_US.UTF-8";

  configurePhase = ''
    runHook preConfigure
    export HOME=$(mktemp -d)
    export MIX_HOME=$HOME/.mix
    export HEX_HOME=$HOME/.hex
    mix local.hex --force
    mix local.rebar --force

    # Link deps
    cp -r ${mixFodDeps} deps
    chmod -R u+w deps

    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild

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
    platforms = platforms.unix;
  };
}
