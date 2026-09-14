export default function handler(req, res) {
  res.status(200).json({
    success: true,
    tokenExists: Boolean(process.env.GITHUB_TOKEN)
  });
}
