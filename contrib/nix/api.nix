{
  lib,
  buildNpmPackage,
  nodejs_22,
  makeWrapper,
  importNpmLock,
  version,
}:

buildNpmPackage rec {
  pname = "kuch-api";
  inherit version;

  src = ./../../api;

  nodejs = nodejs_22;

  npmDeps = importNpmLock { npmRoot = src; };
  npmConfigHook = importNpmLock.npmConfigHook;

  dontNpmBuild = true;

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/kuch-api
    cp -r node_modules $out/lib/kuch-api/
    cp -r coach $out/lib/kuch-api/
    # Every top-level module server.js imports: server.js, password.js, passkeys-store.js,
    # rate-limit.js, media.js, device-link.js, push-messages.js, verify-error.js. Copy the
    # glob rather than an explicit list — a hand-kept list silently ships an incomplete tree
    # and the failure only shows up as ERR_MODULE_NOT_FOUND in the systemd journal.
    cp ./*.js $out/lib/kuch-api/

    mkdir -p $out/bin
    makeWrapper ${nodejs_22}/bin/node $out/bin/kuch-api \
      --add-flags "$out/lib/kuch-api/server.js" \
      --set NODE_ENV production
    runHook postInstall
  '';

  meta = with lib; {
    description = "Kuch API — passkey auth + per-user workout data (Node.js)";
    homepage = "https://github.com/alikulovuzz/kuch";
    license = licenses.agpl3Plus;
    platforms = nodejs.meta.platforms;
  };
}
