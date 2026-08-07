FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY LampaImdbRatings.csproj .
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /out --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /out .
ENV ASPNETCORE_URLS=http://+:8080
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["dotnet", "LampaImdbRatings.dll"]
