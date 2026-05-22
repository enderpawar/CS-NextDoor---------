FROM maven:3.9.9-eclipse-temurin-17 AS build

WORKDIR /app
COPY backend/pom.xml .
RUN mvn -B dependency:go-offline

COPY backend/src ./src
RUN mvn -B clean package -DskipTests

FROM eclipse-temurin:17-jre

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/target/*.jar app.jar

ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["java", "-jar", "app.jar"]
