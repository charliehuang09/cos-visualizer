npm run build
ssh root@dev-orin 'mkdir -p /data/www/cos-visualizer' && \
rsync -avz --delete dist/ root@dev-orin:/data/www/cos-visualizer
rsync -avz nginx.conf root@dev-orin:/etc/nginx/nginx.conf
ssh root@dev-orin 'nginx -t && systemctl reload nginx'
