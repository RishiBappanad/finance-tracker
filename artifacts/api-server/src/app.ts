import express, { type Express } from "express";
import cors from "cors";
import path from "path";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API routes
app.use("/api", router);

// Serve frontend static files in production
if (process.env.NODE_ENV === "production") {
  const publicDir = path.resolve(process.cwd(), "public");
  app.use(express.static(publicDir));

  // SPA fallback — serve index.html for non-API routes (Express 5 syntax)
  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    const indexPath = path.join(publicDir, "index.html");
    res.sendFile(indexPath, (err) => {
      if (err) {
        res.status(404).json({ error: "Not found" });
      }
    });
  });
}

export default app;
