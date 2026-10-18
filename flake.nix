{
  description = "4-bit array multiplier, RTL to GDSII on SKY130";

  # The FOSSi cache holds prebuilt OpenROAD, OpenSTA and Yosys, without it they build from source.
  nixConfig = {
    extra-substituters = [ "https://nix-cache.fossi-foundation.org" ];
    extra-trusted-public-keys = [
      "nix-cache.fossi-foundation.org:3+K59iFwXqKsL7BNu6Guy0v+uTlwsxYQxjspXzqLYQs="
    ];
  };

  inputs.librelane.url = "github:librelane/librelane/3.0.16";

  outputs =
    { librelane, ... }:
    let
      system = "x86_64-linux";
      pkgs = librelane.legacyPackages.${system};
      librelanePackage = pkgs.python3.pkgs.librelane;
    in
    {
      # includedTools is the exact tool set LibreLane runs: yosys, openroad, opensta, magic,
      # netgen, klayout, iverilog, verilator.
      devShells.${system}.default = pkgs.mkShell {
        packages = [
          librelanePackage
          pkgs.gtkwave
        ]
        ++ librelanePackage.includedTools;

        # ciel (pulled in by LibreLane) downloads the SKY130 PDK here on the first LibreLane run.
        shellHook = ''
          export PDK_ROOT="''${PDK_ROOT:-$HOME/.ciel}"
          export PDK=sky130A
        '';
      };
    };
}
