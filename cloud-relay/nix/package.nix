{ lib
, beamPackages
, pkgs
, git
, nodejs
, tailwindcss ? pkgs.tailwindcss
, esbuild ? pkgs.esbuild
}:

let
  src = ../.;
  version = "0.1.0";

  mixFodDeps = beamPackages.fetchMixDeps {
    pname = "relay-mix-deps";
    inherit src version;
    # Run `nix build .#packages.x86_64-linux.default 2>&1 | grep 'got:'` to get the hash.
    sha256 = "sha256-0/5TPeSRbTViMKtxRRUswu0Wt4huD+WiYR9dV+2oNhU=";
  };
in

beamPackages.mixRelease {
  pname = "tmuxdeck-relay";
  inherit src version mixFodDeps;

  nativeBuildInputs = [ git nodejs tailwindcss esbuild ];

  # Point the Mix esbuild/tailwind wrappers to system-packaged binaries
  # so asset compilation works inside the Nix build sandbox.
  ESBUILD_PATH = "${esbuild}/bin/esbuild";
  TAILWIND_PATH = "${tailwindcss}/bin/tailwindcss";

  postBuild = ''
    # Compile and digest assets for production
    mix assets.deploy
  '';

  meta = with lib; {
    description = "TmuxDeck Cloud Relay - tunnel proxy for remote TmuxDeck access";
    license = licenses.mit;
    platforms = platforms.linux;
    mainProgram = "relay";
  };
}
