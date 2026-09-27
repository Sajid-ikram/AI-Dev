# Flutter projects: enough for `flutter analyze` and `flutter test`. There is no Android SDK, so no APK builds.
FROM aidev-base

USER root
RUN mkdir /opt/flutter && chown node:node /opt/flutter
USER node

# Keep in step with the Flutter version the projects use (`flutter --version` on the host).
ARG FLUTTER_VERSION=3.47.3
RUN git clone --depth 1 --branch "${FLUTTER_VERSION}" https://github.com/flutter/flutter.git /opt/flutter
ENV PATH="/opt/flutter/bin:/home/node/.pub-cache/bin:${PATH}"

RUN flutter config --no-analytics \
 && dart --disable-analytics \
 && flutter precache --universal \
 && flutter --version

# Test a throwaway app once, so the test runner and common packages are cached in the image.
RUN cd /tmp \
 && flutter create smoke > /dev/null \
 && cd smoke \
 && flutter test \
 && rm -rf /tmp/smoke
