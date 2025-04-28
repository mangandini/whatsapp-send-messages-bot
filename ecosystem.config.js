module.exports = {
  apps : [
    {
      name   : "web",
      script : "./src/webserver/server.js", // Ruta relativa a la raíz del proyecto
      env: {
        // PORT es gestionado por Coolify/Procfile/Buildpack, no necesita definirse aquí normalmente.
        // Las demás variables de entorno se establecen en Coolify.
      }
    },
    {
      name   : "worker",
      script : "./main.js", // Ruta relativa a la raíz del proyecto
      // No necesita env específicos aquí si usa las variables globales de Coolify
    }
  ]
}; 