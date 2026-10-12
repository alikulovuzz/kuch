{
  lib,
  buildNpmPackage,
  nodejs_22,
  importNpmLock,
  version,
}:

buildNpmPackage rec {
  pname = "kuch-frontend";
  inherit version;

  # The frontend imports api/coach/core/* (../../../api/coach/core/…), so the build
  # needs the repo root — same layout the Dockerfile uses (see web/Dockerfile).
  src = ./../..;
  npmRoot = "frontend";

  nodejs = nodejs_22;

  npmDeps = importNpmLock { npmRoot = src + "/frontend"; };
  npmConfigHook = importNpmLock.npmConfigHook;

  npmBuildScript = "build";

  npmFlags = [ "--ignore-scripts" ];

  buildPhase = ''
    runHook preBuild
    cd frontend
    export NODE_ENV=production
    export PATH="$PWD/node_modules/.bin:$PATH"
    npm run build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/kuch
    cp -r dist/* $out/share/kuch/
    # The exercise stills and animations come from the source tree (catalogue/media, 180 px,
    # licensed from Gym visual for openGym only: see catalogue/media/NOTICE.md). The same script
    # the demo and Android builds use puts them at exercise-media/ next to the app, which is
    # where the app asks for them. Nothing is downloaded, at build time or at runtime.
    env -u APP_MEDIA_DIR node ../scripts/catalogue/stage-media.mjs $out/share/kuch
    runHook postInstall
  '';

  meta = with lib; {
    description = "Kuch frontend — self-hosted gym & body-weight tracker PWA";
    homepage = "https://github.com/alikulovuzz/kuch";
    license = licenses.agpl3Plus;
    platforms = nodejs.meta.platforms;
  };
}
