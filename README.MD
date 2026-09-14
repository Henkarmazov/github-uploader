# GitHub Uploader

GitHub Uploader adalah web application sederhana untuk mengupload file langsung ke repository GitHub menggunakan GitHub REST API.

Project dibuat untuk Vercel menggunakan:

- HTML
- CSS
- Vanilla JavaScript
- Vercel Serverless Functions
- @octokit/rest
- GitHub Git Data API
- JSZip

Tidak menggunakan:

- Database
- Express
- Framework frontend

---

## Features

- Upload satu file
- Upload banyak file
- Upload folder
- Preserve folder structure
- Upload ZIP
- Extract ZIP di browser
- Replace existing files
- Skip existing files
- Drag & drop
- File picker
- Progress bar
- File size display
- Remove file
- Clear all
- Custom repository
- Custom branch
- Custom destination folder
- Custom commit message
- One Git commit for multiple files
- GitHub commit link
- Responsive mobile UI

---

# 1. Install

Clone repository:

```bash
git clone https://github.com/USERNAME/github-uploader.git
cd github-uploader