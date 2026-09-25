import multer from "multer";

// memoryStorage: el archivo llega en req.file.buffer y se sube a Cloudinary
// desde el service. En Vercel no hay disco persistente.
const storage = multer.memoryStorage();

export const uploadMiddleware = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});
