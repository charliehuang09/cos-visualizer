npm run build
rsync -avz --delete dist/ root@dev-orin:/data/www/cos-visualizer
rsync -avz nginx.conf root@dev-orin:/etc/nginx/nginx.conf

