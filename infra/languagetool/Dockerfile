# Self-hosted LanguageTool 6.8 (core + all language modules) resolved from Maven Central.
FROM maven:3.9-eclipse-temurin-21 AS fetch
WORKDIR /lt
COPY pom.xml .
RUN mvn -q -B package

FROM eclipse-temurin:21-jre
RUN apt-get update && apt-get install -y --no-install-recommends wget && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 languagetool
WORKDIR /opt/languagetool
COPY --from=fetch /lt/lib ./lib
COPY server.properties .
USER languagetool
EXPOSE 8081
ENV JAVA_OPTS="-Xms256m -Xmx1g"
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s CMD wget -qO- http://localhost:8081/v2/languages >/dev/null || exit 1
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -cp 'lib/*' org.languagetool.server.HTTPServer --port 8081 --public --allow-origin '*' --config server.properties"]
