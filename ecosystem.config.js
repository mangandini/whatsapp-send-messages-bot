module.exports = {
  apps : [
    {
      name   : "web",
      script : "./src/webserver/server.js", // Relative path to the project root
      env: {
        // PORT is managed by Coolify/Procfile/Buildpack, it does not need to be defined here normally.
      }
    },
    {
      name   : "worker",
      script : "./main.js", // Relative path to the project root
    }
  ]
}; 