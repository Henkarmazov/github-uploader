export default async function handler(req, res) {
  try {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "vercel-github-uploader"
      }
    });

    const data = await response.json();

    return res.status(response.ok ? 200 : response.status).json({
      success: response.ok,
      githubStatus: response.status,
      username: data.login || null,
      message: data.message || null
    });

  } catch (error) {
    console.error("ERROR:", error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
