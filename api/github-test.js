import { Octokit } from "@octokit/rest";

export default async function handler(req, res) {
  try {
    const octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN
    });

    const { data } = await octokit.rest.user.getAuthenticated();

    return res.status(200).json({
      success: true,
      username: data.login
    });

  } catch (error) {
    console.error("GitHub Error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
      status: error.status || null
    });
  }
}
